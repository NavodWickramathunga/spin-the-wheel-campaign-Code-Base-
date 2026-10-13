const express = require('express');
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();

// Collections. Customers are never stored by mobile number: {pid} = HMAC(STW_PII_KEY, identity).
// Docs with expire_at are deleted by Firestore TTL policies (see README).
//   settings/main            caps, cooldown, spin limits, schedule, paused, low_stock_pct
//   rewards/{id}             name, weight, active, is_no_win, daily_limit, created_at, available, allocated, expired
//   vouchers/{code}          code, reward_name, reward_type, voucher_value, expiry_date, status, allocated_to (pid), allocated_at
//   winners/{pid}            last_win_at, expire_at   (one doc per customer -> enforces the cooldown)
//   spinners/{pid}           day, day_count, week, week_count, expire_at   (per-customer spin limits)
//   wins/{auto}              one row per win (the report): mobile_hash (pid), mobile_masked, ..., expire_at
//   stats/day_{date}         wins, reward_wins{rewardId: n}   (read inside the spin transaction for caps)
//   stats/week_{date}        wins
//   stats/act_{date}         spins, hours{HH: n}   (analytics only, never read during a spin)
//   stats/total              spins
//   campaigns/{id}           name, template, html, version, published_at/by, previous {html, version, published_at}   (Studio "Publish"; served to the CleverTap loader)
//   admins/{username}        salt, hash, role (admin | viewer), created_at, created_by
//   login_fails/{sha(user)}  count, first_at, locked_until, expire_at   (admin sign-in lockout)
//   audit/{auto}             at, user, action, details, expire_at
// Secrets live in Google Secret Manager: firebase functions:secrets:set <NAME>
const ADMIN_PASS = defineSecret('ADMIN_PASS');
const TOKEN_SECRET = defineSecret('STW_TOKEN_SECRET'); // shared with Dialog's backend, which issues the customer tokens
const PII_KEY = defineSecret('STW_PII_KEY'); // ours only: turns mobile numbers into pids
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN || 330); // Sri Lanka = UTC+5:30
// off: the token is not checked (rollout); log: checked and failures logged, nothing blocked; enforce: required.
const TOKEN_MODE = ['off', 'log', 'enforce'].includes(process.env.TOKEN_MODE) ? process.env.TOKEN_MODE : 'off';
const TOKEN_CAMPAIGN = process.env.TOKEN_CAMPAIGN || 'stw'; // changing it invalidates every issued token
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 90); // wins (and winner records) are deleted after this
const AUDIT_RETENTION_DAYS = 365;
const DAY_MS = 86400000;
const MIN_SPIN_GAP_MS = 10000; // per customer; see /api/spin
// schedule: when the wheel can be spun, in local (Sri Lanka) time. days: 0 = Sun ... 6 = Sat.
// Empty dates / times mean "no limit"; to = "00:00" means until midnight.
const DEFAULT_SCHEDULE = { enabled: false, start_date: '', end_date: '', days: [0, 1, 2, 3, 4, 5, 6], from: '', to: '' };
const DEFAULT_SETTINGS = {
  daily_cap: 50, weekly_cap: 300, cooldown_days: 30,
  spins_per_day: 0, spins_per_week: 0, // per customer, 0 = no limit
  low_stock_pct: 10, paused: false, schedule: DEFAULT_SCHEDULE,
};
const NUMBER_SETTINGS = { daily_cap: null, weekly_cap: null, cooldown_days: null, spins_per_day: null, spins_per_week: null, low_stock_pct: 100 };

const app = express();
app.use(express.json());
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

// Public customer endpoints are called from the app (CleverTap custom HTML), a different origin.
// CORS_ORIGIN: "*" (default) or a comma-separated allow-list, e.g. "null,https://example.com"
// (an in-app webview often sends Origin "null"; blocked origins are logged so the right value can be found).
const CORS_ORIGINS = String(process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
app.use(['/api/rewards', '/api/spin', '/api/status', '/api/campaign'], (req, res, next) => {
  const origin = req.get('origin');
  if (CORS_ORIGINS.includes('*')) res.set('Access-Control-Allow-Origin', '*');
  else if (origin && CORS_ORIGINS.includes(origin)) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  else if (origin) console.warn('stw: CORS origin not allowed:', origin);
  res.set({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- helpers ----------
const localDate = (d) => new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
const dayKey = (d) => localDate(d).toISOString().slice(0, 10);
function weekKey(d) {
  const l = localDate(d);
  l.setUTCDate(l.getUTCDate() - ((l.getUTCDay() + 6) % 7)); // Monday
  return l.toISOString().slice(0, 10);
}
const localStamp = (iso) => localDate(new Date(iso)).toISOString().slice(0, 19).replace('T', ' ');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const fmtDate = (key) => { const d = new Date(key + 'T00:00:00Z'); return `${DAY_NAMES[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fmtDateYear = (key) => `${fmtDate(key)} ${key.slice(0, 4)}`;
const normIdentity = (v) => String(v || '').replace(/[\s-]/g, '');
const IDENTITY_RE = /^[\w+.@]{3,64}$/;

// ---------- campaign schedule ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const fmtMin = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function validateSchedule(b) {
  const sc = {
    enabled: !!b?.enabled,
    start_date: String(b?.start_date || ''), end_date: String(b?.end_date || ''),
    days: [...new Set((Array.isArray(b?.days) ? b.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort(),
    from: String(b?.from || ''), to: String(b?.to || ''),
  };
  if ((sc.start_date && !DATE_RE.test(sc.start_date)) || (sc.end_date && !DATE_RE.test(sc.end_date))) return { error: 'Dates must be YYYY-MM-DD' };
  if (sc.start_date && sc.end_date && sc.start_date > sc.end_date) return { error: 'End date must be on or after the start date' };
  if ((sc.from && !TIME_RE.test(sc.from)) || (sc.to && !TIME_RE.test(sc.to))) return { error: 'Times must be HH:MM' };
  if (!sc.from !== !sc.to) return { error: 'Set both a start and an end time, or neither' };
  if (sc.from && toMin(sc.to) !== 0 && toMin(sc.to) <= toMin(sc.from)) return { error: 'End time must be after the start time (use 00:00 for midnight)' };
  if (sc.enabled && !sc.days.length) return { error: 'Pick at least one day of the week' };
  return { schedule: sc };
}

// Is the wheel open at `now`? When closed, says when it opens next (looks up to 60 days ahead).
function scheduleStatus(sc, now) {
  if (!sc || !sc.enabled) return { open: true };
  const l = localDate(now);
  const nowMin = l.getUTCHours() * 60 + l.getUTCMinutes();
  const from = toMin(sc.from) ?? 0, to = sc.to ? toMin(sc.to) || 1440 : 1440;
  for (let k = 0; k <= 60; k++) {
    const d = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + k));
    const date = d.toISOString().slice(0, 10), dow = d.getUTCDay();
    if (sc.end_date && date > sc.end_date) break;
    if ((sc.start_date && date < sc.start_date) || !sc.days.includes(dow)) continue;
    const start = k === 0 ? Math.max(from, nowMin) : from;
    if (start >= to) continue;
    if (k === 0 && start === nowMin) return { open: true, closes_at: fmtMin(to % 1440) };
    const when = k === 0 ? 'today' : k === 1 ? 'tomorrow' : `on ${fmtDate(date)}`;
    return { open: false, next_open: `${date} ${fmtMin(start)}`, message: `The wheel is closed right now. It opens ${when} at ${fmtMin(start)}.` };
  }
  // No window left before the end date = the campaign is over.
  return { open: false, message: sc.end_date
    ? 'This campaign has ended. Thanks for playing!' : 'The wheel is closed right now. Please check back later.' };
}

// ---------- can this customer spin right now? ----------
function spinUsage(spinner, now) {
  const today = dayKey(now), week = weekKey(now);
  return {
    today, week,
    usedDay: spinner?.day === today ? spinner.day_count || 0 : 0,
    usedWeek: spinner?.week === week ? spinner.week_count || 0 : 0,
  };
}
// open: false -> paused / outside the schedule (the popup closes silently).
// eligible: false -> open, but this customer can't spin now (the popup explains why).
function customerGate(s, now, winner, spinner) {
  if (s.paused) return { open: false, paused: true, message: 'The wheel is taking a short break. Please check back soon.' };
  const sched = scheduleStatus(s.schedule, now);
  if (!sched.open) return sched;
  if (winner?.last_win_at) {
    const next = new Date(new Date(winner.last_win_at).getTime() + s.cooldown_days * DAY_MS);
    if (next > now) return { open: true, eligible: false, reason: 'won', message: `You've already won a reward. Your next chance is on ${fmtDate(dayKey(next))}.` };
  }
  const u = spinUsage(spinner, now);
  if (s.spins_per_day > 0 && u.usedDay >= s.spins_per_day) {
    return { open: true, eligible: false, reason: 'limit', message: `You've used today's ${s.spins_per_day === 1 ? 'spin' : 'spins'}. Come back tomorrow for another chance!` };
  }
  if (s.spins_per_week > 0 && u.usedWeek >= s.spins_per_week) {
    return { open: true, eligible: false, reason: 'limit', message: `You've used this week's ${s.spins_per_week === 1 ? 'spin' : 'spins'}. Your next chance is on ${fmtDate(addDays(u.week, 7))}.` };
  }
  return { open: true, eligible: true, ...(sched.closes_at ? { closes_at: sched.closes_at } : {}) };
}

const enc = encodeURIComponent;

// ---------- customer verification & PII ----------
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
// Dialog's backend gives each customer token = base64url(HMAC-SHA256(STW_TOKEN_SECRET, "<TOKEN_CAMPAIGN>:<identity>"))
// on their CleverTap profile (property stw_token); the popup sends it with the identity. See tools/make-tokens.js.
const tokenFor = (identity) => hmac(TOKEN_SECRET.value(), `${TOKEN_CAMPAIGN}:${identity}`).toString('base64url');
function verifyToken(identity, token) {
  const ok = !!TOKEN_SECRET.value() && !!token && safeEq(String(token), tokenFor(identity));
  if (!ok && TOKEN_MODE !== 'off') console.warn(`stw: ${token ? 'invalid' : 'missing'} customer token`);
  return ok;
}
// Can this request act for the identity it names?
const tokenOk = (identity, token) => TOKEN_MODE !== 'enforce' || verifyToken(identity, token);
// Without a valid token the reason a customer can't play (e.g. "already won") isn't revealed to the caller.
const knownCustomer = (identity, token) => TOKEN_MODE !== 'off' && verifyToken(identity, token);
const UNVERIFIED = { open: true, eligible: false, reason: 'unverified', message: 'Please open this from the MyDialog app to play.' };
const VAGUE = { open: true, eligible: false, reason: 'unavailable', message: "You can't play right now. Please check back later." };
const publicGate = (gate, known) => (gate.eligible === false && !known ? VAGUE : gate);

const pid = (identity) => {
  const key = PII_KEY.value();
  if (!key) throw new Error('STW_PII_KEY is not set');
  return hmac(key, identity).toString('hex');
};
const PID_RE = /^[0-9a-f]{64}$/;
const mask = (identity) => '*'.repeat(Math.max(4, identity.length - 4)) + identity.slice(-4);
const expireIn = (days, from = Date.now()) => Timestamp.fromMillis(from + days * DAY_MS);
// Report rows without the internal fields.
const winRow = ({ mobile_hash, expire_at, mobile, ...r }) => ({ ...r, mobile_masked: r.mobile_masked || (mobile ? mask(mobile) : '') });

const bodyText = (req) =>
  typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.rawBody ? req.rawBody.toString('utf8') : '';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
const csvEscape = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// Accepts YYYY-MM-DD, or DD/MM/YYYY as Excel often saves it. Returns '' for empty, null for invalid.
function parseExpiry(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (DATE_RE.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const isExpired = (v, today) => !!v.expiry_date && v.expiry_date < today;
function pickWeighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  let r = (crypto.randomInt(0, 1e9) / 1e9) * total;
  for (const i of items) { if ((r -= i.weight) < 0) return i; }
  return items[items.length - 1];
}
const byOrder = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.name.localeCompare(b.name));

let seeded = false;
async function ensureSeed() {
  if (seeded) return;
  const ref = db.collection('rewards').doc('no-win');
  if (!(await ref.get()).exists) {
    await ref.set({ name: 'Better luck next time', weight: 5, active: true, is_no_win: true, created_at: '2000-01-01T00:00:00.000Z', available: 0, allocated: 0 });
  }
  const s = db.collection('settings').doc('main');
  if (!(await s.get()).exists) await s.set(DEFAULT_SETTINGS);
  seeded = true;
}
const settingsOf = (snap) => ({ ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) });
const getSettings = async () => settingsOf(await db.collection('settings').doc('main').get());
const rewardRow = (d) => ({ id: d.id, ...d.data() });

// ---------- customer API ----------
app.get('/api/rewards', async (req, res) => {
  try {
    await ensureSeed();
    const snap = await db.collection('rewards').where('active', '==', true).get();
    res.json(snap.docs.map(rewardRow).sort(byOrder).map((r) => ({ id: r.id, name: r.name, isNoWin: !!r.is_no_win })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// The popup asks this before showing the wheel: closed -> it closes silently; not eligible -> it explains why.
// Never returns voucher codes; says why a customer can't play only when their token is valid.
app.get('/api/status', async (req, res) => {
  try {
    const identity = normIdentity(req.query.identity), token = req.query.token;
    const now = new Date();
    if (!IDENTITY_RE.test(identity)) return res.json(customerGate(await getSettings(), now, null, null));
    if (!tokenOk(identity, token)) {
      const gate = customerGate(await getSettings(), now, null, null);
      return res.json(gate.open ? UNVERIFIED : gate);
    }
    const id = pid(identity);
    const [s, w, sp] = await Promise.all([
      getSettings(), db.collection('winners').doc(id).get(), db.collection('spinners').doc(id).get(),
    ]);
    res.json(publicGate(customerGate(s, now, w.data(), sp.data()), knownCustomer(identity, token)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/spin', async (req, res) => {
  // The customer's CleverTap Identity (their mobile number). `mobile` is still accepted for older links.
  const identity = normIdentity(req.body?.identity || req.body?.mobile);
  if (!IDENTITY_RE.test(identity)) {
    return res.status(400).json({ error: 'Invalid identity. Please open this page from the MyDialog app.' });
  }
  if (!tokenOk(identity, req.body?.token)) return res.status(401).json({ error: UNVERIFIED.message, ineligible: true });
  const known = knownCustomer(identity, req.body?.token);
  try {
    await ensureSeed();
    const now = new Date();
    const nowIso = now.toISOString();
    const id = pid(identity);
    const winnerRef = db.collection('winners').doc(id);
    const spinnerRef = db.collection('spinners').doc(id);
    const dayRef = db.collection('stats').doc('day_' + dayKey(now));
    const weekRef = db.collection('stats').doc('week_' + weekKey(now));

    const result = await db.runTransaction(async (t) => {
      const [setSnap, winnerSnap, spinnerSnap, daySnap, weekSnap, rewardSnap] = await Promise.all([
        t.get(db.collection('settings').doc('main')), t.get(winnerRef), t.get(spinnerRef), t.get(dayRef), t.get(weekRef),
        t.get(db.collection('rewards').where('active', '==', true)),
      ]);
      const s = settingsOf(setSnap);

      // Pause, schedule, winner cooldown and per-customer spin limits.
      const gate = publicGate(customerGate(s, now, winnerSnap.data(), spinnerSnap.data()), known);
      if (!gate.open) return { status: 403, body: { error: gate.message, closed: true } };
      if (!gate.eligible) return { status: 403, body: { error: gate.message, ineligible: true } };
      // A second spin this soon is a duplicate (two popups open, or a request sent twice), never a real player:
      // one spin animation alone takes longer. Without this a short cooldown lets both win.
      const last = spinnerSnap.data()?.last_spin_at;
      if (last && now - new Date(last) < MIN_SPIN_GAP_MS) {
        return { status: 429, body: { error: 'You just played. Please close this and try again in a moment.', ineligible: true } };
      }

      const rewards = rewardSnap.docs.map(rewardRow).sort(byOrder);
      const noWin = rewards.find((r) => r.is_no_win);
      const day = daySnap.exists ? daySnap.data() : {};
      const capped = (day.wins || 0) >= s.daily_cap || (weekSnap.exists ? weekSnap.data().wins || 0 : 0) >= s.weekly_cap;
      const underRewardLimit = (r) => !(r.daily_limit > 0) || ((day.reward_wins || {})[r.id] || 0) < r.daily_limit;
      const eligible = rewards.filter((r) => r.is_no_win || (!capped && r.available > 0 && underRewardLimit(r)));
      let pick = pickWeighted(eligible) || noWin;
      if (!pick) return { status: 503, body: { error: 'All rewards have been claimed for now. Please try again later.' } };

      // Take an unexpired voucher; expired ones met on the way are retired.
      let voucher = null, expired = [];
      const u = spinUsage(spinnerSnap.data(), now);
      if (!pick.is_no_win) {
        const q = await t.get(db.collection('vouchers').where('reward_name', '==', pick.name).where('status', '==', 'available').limit(20));
        expired = q.docs.filter((d) => isExpired(d.data(), u.today));
        voucher = q.docs.find((d) => !isExpired(d.data(), u.today)) || null;
        if (!voucher) {
          const prizeRef = db.collection('rewards').doc(pick.id);
          pick = noWin; // out of usable vouchers: don't fail the spin
          if (expired.length) t.update(prizeRef, { available: FieldValue.increment(-expired.length), expired: FieldValue.increment(expired.length) });
          expired.forEach((d) => t.update(d.ref, { status: 'expired' }));
          expired = [];
        }
      }
      if (!pick) return { status: 503, body: { error: 'All rewards have been claimed for now. Please try again later.' } };

      const won = !pick.is_no_win;
      const v = voucher ? voucher.data() : null;
      expired.forEach((d) => t.update(d.ref, { status: 'expired' }));
      if (won) {
        t.update(voucher.ref, { status: 'allocated', allocated_to: id, allocated_at: nowIso });
        t.update(db.collection('rewards').doc(pick.id), {
          available: FieldValue.increment(-1 - expired.length), allocated: FieldValue.increment(1),
          ...(expired.length ? { expired: FieldValue.increment(expired.length) } : {}),
        });
        // Kept at least as long as the cooldown, so a deleted record never lets someone win again early.
        t.set(winnerRef, { last_win_at: nowIso, last_voucher: v.code, expire_at: expireIn(Math.max(s.cooldown_days, RETENTION_DAYS) + 1) }, { merge: true });
        t.set(db.collection('wins').doc(), {
          created_at: nowIso, mobile_hash: id, mobile_masked: mask(identity), reward_id: pick.id, reward_name: pick.name, reward_type: v.reward_type,
          voucher_code: v.code, voucher_value: v.voucher_value || pick.name, expiry_date: v.expiry_date || '', expire_at: expireIn(RETENTION_DAYS),
        });
        t.set(dayRef, { wins: FieldValue.increment(1), reward_wins: { [pick.id]: FieldValue.increment(1) } }, { merge: true });
        t.set(weekRef, { wins: FieldValue.increment(1) }, { merge: true });
      }
      t.set(spinnerRef, { day: u.today, day_count: u.usedDay + 1, week: u.week, week_count: u.usedWeek + 1, last_spin_at: nowIso, expire_at: expireIn(14) });
      const hour = String(localDate(now).getUTCHours()).padStart(2, '0');
      t.set(db.collection('stats').doc('act_' + u.today), { spins: FieldValue.increment(1), hours: { [hour]: FieldValue.increment(1) } }, { merge: true });
      t.set(db.collection('stats').doc('total'), { spins: FieldValue.increment(1) }, { merge: true });

      return {
        status: 200,
        body: {
          segmentIndex: rewards.findIndex((r) => r.id === pick.id),
          reward: pick.name,
          won,
          voucherCode: won ? v.code : null,
          voucherValue: won ? v.voucher_value || pick.name : '',
          expiryDate: won && v.expiry_date ? fmtDateYear(v.expiry_date) : '',
        },
      };
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- admin auth: the .env owner account plus accounts in admins/{username} ----------
// role "admin" can change everything; role "viewer" (e.g. managers) can only look.
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scryptHex = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? no(e) : ok(k.toString('hex')))));
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const authCache = new Map(); // sha(credentials) -> { who, until }; short-lived so removed accounts stop working quickly
async function checkLogin(user, pass) {
  const ownerPass = ADMIN_PASS.value();
  if (ownerPass && safeEq(`${user}:${pass}`, `${ADMIN_USER}:${ownerPass}`)) return { user, role: 'admin', owner: true };
  const name = user.toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  const snap = await db.collection('admins').doc(name).get();
  if (!snap.exists) return null;
  const a = snap.data();
  return safeEq(await scryptHex(pass, a.salt), a.hash) ? { user: name, role: a.role } : null;
}
// After MAX_LOGIN_FAILS wrong passwords within LOCK_MS the username is locked for LOCK_MS (shared by all instances).
const MAX_LOGIN_FAILS = 5, LOCK_MS = 15 * 60000;
async function noteLoginFail(ref, f) {
  const now = Date.now(), fresh = !f || now - f.first_at > LOCK_MS;
  const count = fresh ? 1 : f.count + 1;
  await ref.set({ count, first_at: fresh ? now : f.first_at, locked_until: count >= MAX_LOGIN_FAILS ? now + LOCK_MS : 0, expire_at: expireIn(1) });
  if (count >= MAX_LOGIN_FAILS) console.warn('stw: admin sign-in locked after repeated failures');
}
async function adminAuth(req, res, next) {
  try {
    // Changes must come from the console's own scripts: a custom header can't be sent cross-site without
    // CORS approval (which /api/admin never gives), so other sites can't use a signed-in browser.
    if (req.method !== 'GET' && req.get('x-stw-admin') !== '1') return res.status(403).json({ error: 'Forbidden' });
    res.set('Cache-Control', 'no-store');
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && token) {
      const key = sha(token), hit = authCache.get(key);
      let who = hit && hit.until > Date.now() ? hit.who : null;
      if (!who) {
        const raw = Buffer.from(token, 'base64').toString(), i = raw.indexOf(':');
        if (i > 0) {
          const user = raw.slice(0, i), failRef = db.collection('login_fails').doc(sha(user.toLowerCase()));
          const f = (await failRef.get()).data();
          if (f?.locked_until > Date.now()) {
            const mins = Math.ceil((f.locked_until - Date.now()) / 60000);
            return res.status(429).json({ error: `Too many wrong passwords. Sign-in is locked for ${mins} more minute${mins === 1 ? '' : 's'}.` });
          }
          who = await checkLogin(user, raw.slice(i + 1));
          if (who && f) await failRef.delete();
          if (!who) await noteLoginFail(failRef, f);
        }
        if (who) authCache.set(key, { who, until: Date.now() + 60000 });
      }
      if (who) {
        req.admin = who;
        if (who.role !== 'admin' && req.method !== 'GET') return res.status(403).json({ error: 'Your account is view-only.' });
        return next();
      }
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Authentication required');
}
app.use('/api/admin', adminAuth);
const adminOnly = (req, res, next) => (req.admin.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' }));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const audit = (req, action, details) => db.collection('audit')
  .add({ at: new Date().toISOString(), user: req.admin.user, action, details: details || {}, expire_at: expireIn(AUDIT_RETENTION_DAYS) })
  .catch((e) => console.error('audit', e));

// ---------- published campaigns ----------
// Studio publishes the finished page here; the small loader pasted into CleverTap once fetches and renders it.
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_CAMPAIGN_HTML = 400 * 1024;
app.get('/api/campaign/:id', wrap(async (req, res) => {
  const snap = CAMPAIGN_ID.test(req.params.id) ? await db.collection('campaigns').doc(req.params.id).get() : null;
  res.set('Cache-Control', 'no-cache');
  if (!snap || !snap.exists) return res.status(404).json({ error: 'Not found' });
  const d = snap.data();
  res.json({ html: d.html, version: d.version });
}));
const campaignInfo = (id, d) => ({ id, name: d.name, template: d.template, version: d.version, published_at: d.published_at, published_by: d.published_by, can_rollback: !!d.previous });
app.get('/api/admin/campaigns', wrap(async (req, res) => {
  const snap = await db.collection('campaigns').get();
  res.json(snap.docs.map((x) => campaignInfo(x.id, x.data())).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))));
}));
app.put('/api/admin/campaigns/:id', wrap(async (req, res) => {
  const id = req.params.id, { html, name, template } = req.body || {};
  if (!CAMPAIGN_ID.test(id)) return res.status(400).json({ error: 'Campaign ID: 3-40 characters, lowercase letters, numbers and dashes.' });
  if (typeof html !== 'string' || !html.includes('const CONFIG') || html.length > MAX_CAMPAIGN_HTML) return res.status(400).json({ error: 'That does not look like a valid template.' });
  const ref = db.collection('campaigns').doc(id);
  const out = await db.runTransaction(async (tx) => {
    const old = (await tx.get(ref)).data();
    const doc = {
      name: String(name || id).slice(0, 80), template: String(template || '').slice(0, 60), html,
      version: (old?.version || 0) + 1, published_at: new Date().toISOString(), published_by: req.admin.user,
      previous: old ? { html: old.html, version: old.version, published_at: old.published_at } : null,
    };
    tx.set(ref, doc);
    return doc;
  });
  audit(req, 'Published campaign', { id, version: out.version });
  res.json(campaignInfo(id, out));
}));
app.post('/api/admin/campaigns/:id/rollback', wrap(async (req, res) => {
  const ref = db.collection('campaigns').doc(req.params.id);
  const out = await db.runTransaction(async (tx) => {
    const old = (await tx.get(ref)).data();
    if (!old?.previous) return null;
    const doc = { ...old, html: old.previous.html, version: old.version + 1, published_at: new Date().toISOString(), published_by: req.admin.user, previous: null };
    tx.set(ref, doc);
    return doc;
  });
  if (!out) return res.status(400).json({ error: 'No earlier version to go back to.' });
  audit(req, 'Rolled back campaign', { id: req.params.id, version: out.version });
  res.json(campaignInfo(req.params.id, out));
}));

app.get('/api/admin/me', (req, res) => res.json({ user: req.admin.user, role: req.admin.role, owner: !!req.admin.owner }));

// ---------- settings, schedule, pause ----------
app.get('/api/admin/settings', wrap(async (req, res) => { await ensureSeed(); res.json(await getSettings()); }));
app.put('/api/admin/settings', wrap(async (req, res) => {
  const out = {};
  for (const [k, max] of Object.entries(NUMBER_SETTINGS)) {
    if (req.body?.[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isInteger(n) || n < 0 || (max !== null && n > max)) return res.status(400).json({ error: `${k} must be a whole number from 0${max !== null ? ' to ' + max : ''}` });
    out[k] = n;
  }
  await db.collection('settings').doc('main').set(out, { merge: true });
  audit(req, 'Changed limits', out);
  res.json(await getSettings());
}));

app.put('/api/admin/schedule', wrap(async (req, res) => {
  const v = validateSchedule(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await db.collection('settings').doc('main').set({ schedule: v.schedule }, { merge: true });
  audit(req, 'Changed schedule', v.schedule);
  res.json({ schedule: v.schedule, status: customerGate(await getSettings(), new Date(), null, null) });
}));

app.put('/api/admin/pause', wrap(async (req, res) => {
  const paused = !!req.body?.paused;
  await db.collection('settings').doc('main').set({ paused }, { merge: true });
  audit(req, paused ? 'Paused the wheel' : 'Resumed the wheel');
  res.json({ paused, status: customerGate(await getSettings(), new Date(), null, null) });
}));

// ---------- overview ----------
app.get('/api/admin/summary', wrap(async (req, res) => {
  await ensureSeed();
  const now = new Date();
  const [d, w, act, tot, rw, s] = await Promise.all([
    db.collection('stats').doc('day_' + dayKey(now)).get(), db.collection('stats').doc('week_' + weekKey(now)).get(),
    db.collection('stats').doc('act_' + dayKey(now)).get(), db.collection('stats').doc('total').get(),
    db.collection('rewards').get(), getSettings(),
  ]);
  res.json({
    status: customerGate(s, now, null, null),
    paused: !!s.paused,
    winsToday: d.exists ? d.data().wins || 0 : 0,
    winsThisWeek: w.exists ? w.data().wins || 0 : 0,
    spinsToday: act.exists ? act.data().spins || 0 : 0,
    totalSpins: tot.exists ? tot.data().spins || 0 : 0,
    stock: rw.docs.map(rewardRow).filter((r) => !r.is_no_win).sort(byOrder).map((r) => {
      const available = r.available || 0, allocated = r.allocated || 0, expired = r.expired || 0;
      const total = available + allocated + expired;
      const level = available <= 0 ? 'out' : available <= Math.ceil((total * s.low_stock_pct) / 100) ? 'low' : '';
      return { name: r.name, active: !!r.active, available, allocated, expired, level };
    }),
  });
}));

app.get('/api/admin/analytics', wrap(async (req, res) => {
  const n = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const today = dayKey(new Date());
  const keys = Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
  const [daySnaps, actSnaps, rw] = await Promise.all([
    db.getAll(...keys.map((k) => db.collection('stats').doc('day_' + k))),
    db.getAll(...keys.map((k) => db.collection('stats').doc('act_' + k))),
    db.collection('rewards').get(),
  ]);
  const names = Object.fromEntries(rw.docs.map((d) => [d.id, d.data().name]));
  const byReward = {};
  const days = keys.map((date, i) => {
    const dd = daySnaps[i].exists ? daySnaps[i].data() : {}, ad = actSnaps[i].exists ? actSnaps[i].data() : {};
    for (const [id, c] of Object.entries(dd.reward_wins || {})) byReward[names[id] || id] = (byReward[names[id] || id] || 0) + c;
    return { date, spins: ad.spins || 0, wins: dd.wins || 0 };
  });
  const last = actSnaps[n - 1].exists ? actSnaps[n - 1].data().hours || {} : {};
  res.json({ days, byReward, hoursToday: Array.from({ length: 24 }, (_, h) => last[String(h).padStart(2, '0')] || 0) });
}));

// ---------- segments ----------
app.get('/api/admin/rewards', wrap(async (req, res) => {
  await ensureSeed();
  const snap = await db.collection('rewards').get();
  res.json(snap.docs.map(rewardRow).sort(byOrder).map((r) => ({
    id: r.id, name: r.name, weight: r.weight, active: r.active ? 1 : 0, is_no_win: r.is_no_win ? 1 : 0, daily_limit: r.daily_limit || 0,
  })));
}));
app.put('/api/admin/rewards', wrap(async (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected a list' });
  const batch = db.batch();
  for (const r of list) {
    const w = Number(r.weight), lim = Number(r.daily_limit || 0);
    if (!(w >= 0)) return res.status(400).json({ error: 'Weight must be ≥ 0' });
    if (!Number.isInteger(lim) || lim < 0) return res.status(400).json({ error: 'Daily limit must be a whole number ≥ 0' });
    batch.update(db.collection('rewards').doc(String(r.id)), { weight: w, active: !!r.active, daily_limit: lim });
  }
  await batch.commit();
  audit(req, 'Changed segments', { segments: list.map((r) => `${r.name}: weight ${r.weight}, ${r.active ? 'active' : 'hidden'}, daily limit ${r.daily_limit || 'none'}`) });
  res.json({ ok: true });
}));

// ---------- vouchers ----------
app.post('/api/admin/vouchers', wrap(async (req, res) => {
  const text = bodyText(req);
  if (!text) return res.status(400).json({ error: 'Send CSV as text/csv' });
  await ensureSeed();
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length && /^code$/i.test(rows[0][0].trim())) rows.shift(); // header
  let added = 0, duplicates = 0, invalid = 0;

  const seen = new Set(), fresh = [];
  for (const [code, name, type, value, expiry] of rows) {
    const exp = parseExpiry(expiry);
    if (!code?.trim() || !name?.trim() || exp === null) { invalid++; continue; }
    const c = code.trim();
    if (c === '.' || c === '..' || seen.has(c)) { duplicates++; continue; }
    seen.add(c);
    fresh.push({ code: c, reward_name: name.trim(), reward_type: (type || '').trim(), voucher_value: (value || '').trim(), expiry_date: exp });
  }
  // Drop codes that already exist (a code can be fed only once).
  const toAdd = [];
  for (let i = 0; i < fresh.length; i += 300) {
    const chunk = fresh.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map((v) => db.collection('vouchers').doc(enc(v.code))));
    snaps.forEach((s, k) => (s.exists ? duplicates++ : toAdd.push(chunk[k])));
  }
  if (toAdd.length) {
    const counts = {};
    toAdd.forEach((v) => (counts[v.reward_name] = (counts[v.reward_name] || 0) + 1));
    const names = Object.keys(counts);
    const rewardRefs = names.map((n) => db.collection('rewards').doc(enc(n)));
    const rewardSnaps = await db.getAll(...rewardRefs);
    const ops = [];
    names.forEach((n, i) => {
      if (rewardSnaps[i].exists) ops.push((b) => b.update(rewardRefs[i], { available: FieldValue.increment(counts[n]) }));
      else ops.push((b) => b.set(rewardRefs[i], { name: n, weight: 1, active: true, is_no_win: false, daily_limit: 0, created_at: new Date().toISOString(), available: counts[n], allocated: 0, expired: 0 }));
    });
    toAdd.forEach((v) => ops.push((b) => b.set(db.collection('vouchers').doc(enc(v.code)), { ...v, status: 'available', allocated_to: null, allocated_at: null })));
    for (let i = 0; i < ops.length; i += 400) {
      const b = db.batch();
      ops.slice(i, i + 400).forEach((op) => op(b));
      await b.commit();
    }
    added = toAdd.length;
  }
  audit(req, 'Uploaded vouchers', { added, duplicates, invalid });
  res.json({ added, duplicates, invalid });
}));

// ---------- winners & customer lookup ----------
async function winsBetween(from, to, limit) {
  let q = db.collection('wins').where('created_at', '>=', from).where('created_at', '<', to).orderBy('created_at', 'desc');
  if (limit) q = q.limit(limit);
  return (await q.get()).docs.map((d) => winRow(d.data()));
}
app.get('/api/admin/winners', wrap(async (req, res) => {
  res.json(await winsBetween('0000', '9999', 1000));
}));
app.get('/api/admin/winners.csv', wrap(async (req, res) => {
  // optional ?date=YYYY-MM-DD limits the report to that day (Sri Lanka time by default)
  let from = '0000', to = '9999';
  if (DATE_RE.test(req.query.date || '')) {
    const start = Date.parse(req.query.date + 'T00:00:00Z') - TZ_OFFSET_MIN * 60000;
    from = new Date(start).toISOString();
    to = new Date(start + DAY_MS).toISOString();
  }
  const rows = (await winsBetween(from, to)).reverse();
  const head = 'Date (Sri Lanka time),Mobile (masked),Voucher Code,Voucher Value,Reward,Reward Type,Expiry Date';
  const body = rows.map((r) => [localStamp(r.created_at), r.mobile_masked, r.voucher_code, r.voucher_value || r.reward_name, r.reward_name, r.reward_type, r.expiry_date].map(csvEscape).join(','));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="winners-${req.query.date || dayKey(new Date())}.csv"`,
  }).send('﻿' + [head, ...body].join('\r\n'));
}));

// Support: what did this customer win, and can they spin now?
app.get('/api/admin/customer', wrap(async (req, res) => {
  const mobile = normIdentity(req.query.mobile);
  if (!IDENTITY_RE.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number / identity' });
  const id = pid(mobile);
  const [wins, w, sp, s] = await Promise.all([
    db.collection('wins').where('mobile_hash', '==', id).limit(100).get(),
    db.collection('winners').doc(id).get(), db.collection('spinners').doc(id).get(), getSettings(),
  ]);
  const now = new Date(), gate = customerGate({ ...s, paused: false, schedule: DEFAULT_SCHEDULE }, now, w.data(), sp.data());
  const u = spinUsage(sp.data(), now);
  res.json({
    mobile,
    canSpin: gate.eligible !== false,
    message: gate.eligible === false ? gate.message : 'Can spin now (when the wheel is open).',
    spinsToday: u.usedDay, spinsThisWeek: u.usedWeek,
    wins: wins.docs.map((d) => winRow(d.data())).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
  });
}));
// A browser test link that plays as this customer (adds their token). Admins only, logged.
app.get('/api/admin/test-token', adminOnly, wrap(async (req, res) => {
  const mobile = normIdentity(req.query.mobile);
  if (!IDENTITY_RE.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number / identity' });
  if (!TOKEN_SECRET.value()) return res.status(400).json({ error: 'STW_TOKEN_SECRET is not set' });
  audit(req, 'Created test link', { mobile: mask(mobile) });
  res.json({ identity: mobile, token: tokenFor(mobile) });
}));
// Clears the cooldown and spin counters for one customer (e.g. testers during the demo).
app.post('/api/admin/customer/reset', wrap(async (req, res) => {
  const mobile = normIdentity(req.body?.mobile);
  if (!IDENTITY_RE.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number / identity' });
  const id = pid(mobile);
  await Promise.all([db.collection('winners').doc(id).delete(), db.collection('spinners').doc(id).delete()]);
  audit(req, 'Reset customer', { mobile: mask(mobile) });
  res.json({ ok: true });
}));

// One-off: converts data written before mobile numbers were hashed (doc IDs, wins.mobile, vouchers.allocated_to,
// audit entries) and adds expire_at everywhere. Safe to run more than once.
app.post('/api/admin/migrate-pii', adminOnly, wrap(async (req, res) => {
  const w = db.bulkWriter(), n = { winners: 0, spinners: 0, wins: 0, vouchers: 0, audit: 0 };
  const plain = (docId) => normIdentity(decodeURIComponent(docId));
  const winnerDays = Math.max((await getSettings()).cooldown_days, RETENTION_DAYS) + 1;
  for (const [col, days] of [['winners', null], ['spinners', 14]]) {
    for (const d of (await db.collection(col).get()).docs) {
      if (PID_RE.test(d.id)) continue;
      const data = d.data(), target = db.collection(col).doc(pid(plain(d.id)));
      // A record written after the switch is newer; keep it.
      if (!(await target.get()).exists) {
        const exp = days ? expireIn(days) : expireIn(winnerDays, Date.parse(data.last_win_at) || Date.now());
        w.set(target, { ...data, expire_at: exp });
      }
      w.delete(d.ref); n[col]++;
    }
  }
  for (const d of (await db.collection('wins').get()).docs) {
    const r = d.data();
    if (!r.mobile && r.expire_at) continue;
    w.update(d.ref, {
      ...(r.mobile ? { mobile_hash: pid(normIdentity(r.mobile)), mobile_masked: mask(normIdentity(r.mobile)), mobile: FieldValue.delete() } : {}),
      expire_at: expireIn(RETENTION_DAYS, Date.parse(r.created_at) || Date.now()),
    });
    n.wins++;
  }
  for (const d of (await db.collection('vouchers').where('status', '==', 'allocated').get()).docs) {
    const to = d.data().allocated_to;
    if (to && !PID_RE.test(to)) { w.update(d.ref, { allocated_to: pid(normIdentity(to)) }); n.vouchers++; }
  }
  for (const d of (await db.collection('audit').get()).docs) {
    const a = d.data(), m = a.details?.mobile, raw = !!m && !m.includes('*');
    if (a.expire_at && !raw) continue;
    w.update(d.ref, {
      ...(raw ? { 'details.mobile': mask(normIdentity(m)) } : {}),
      expire_at: expireIn(AUDIT_RETENTION_DAYS, Date.parse(a.at) || Date.now()),
    });
    n.audit++;
  }
  await w.close();
  audit(req, 'Migrated customer data to hashed IDs', n);
  res.json(n);
}));

// ---------- admin accounts & audit log ----------
app.get('/api/admin/users', adminOnly, wrap(async (req, res) => {
  const snap = await db.collection('admins').get();
  res.json([
    { username: ADMIN_USER, role: 'admin', owner: true },
    ...snap.docs.map((d) => ({ username: d.id, role: d.data().role, created_at: d.data().created_at, created_by: d.data().created_by })),
  ]);
}));
app.post('/api/admin/users', adminOnly, wrap(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase(), password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'viewer';
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3-32 characters, letters, numbers, . _ -' });
  if (username === ADMIN_USER.toLowerCase()) return res.status(400).json({ error: 'That username is the owner account' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const salt = crypto.randomBytes(16).toString('hex');
  const ref = db.collection('admins').doc(username), existed = (await ref.get()).exists;
  await ref.set({ salt, hash: await scryptHex(password, salt), role, created_at: new Date().toISOString(), created_by: req.admin.user });
  authCache.clear();
  audit(req, existed ? 'Updated admin account' : 'Added admin account', { username, role });
  res.json({ ok: true });
}));
app.delete('/api/admin/users/:username', adminOnly, wrap(async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  if (username === req.admin.user) return res.status(400).json({ error: "You can't remove your own account" });
  await db.collection('admins').doc(username).delete();
  authCache.clear();
  audit(req, 'Removed admin account', { username });
  res.json({ ok: true });
}));
app.get('/api/admin/audit', wrap(async (req, res) => {
  const snap = await db.collection('audit').orderBy('at', 'desc').limit(200).get();
  res.json(snap.docs.map((d) => { const { expire_at, ...a } = d.data(); return a; }));
}));

exports.api = onRequest({ region: 'asia-southeast1', maxInstances: 10, memory: '256MiB', secrets: [ADMIN_PASS, TOKEN_SECRET, PII_KEY] }, app);
