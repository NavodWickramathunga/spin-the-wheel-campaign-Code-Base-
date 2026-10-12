const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, getSettings, tx } = require('./db');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const DAY_MS = 86400000;

const app = express();
app.use(express.json());
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// The wheel runs inside the app (CleverTap custom HTML), a different origin from this server,
// so the two public customer endpoints allow cross-origin calls. Admin endpoints stay same-origin.
app.use(['/api/rewards', '/api/spin'], (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- helpers ----------
const activeRewards = () =>
  db.prepare('SELECT id,name,weight,is_no_win FROM rewards WHERE active=1 ORDER BY id').all();

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfWeek() {
  const d = startOfToday();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d;
}
const winsSince = (d) =>
  db.prepare('SELECT COUNT(*) c FROM spins WHERE won=1 AND created_at>=?').get(d.toISOString()).c;

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

function pickWeighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  let r = crypto.randomInt(0, 1e9) / 1e9 * total;
  for (const i of items) { if ((r -= i.weight) < 0) return i; }
  return items[items.length - 1];
}

// ---------- customer API ----------
app.get('/api/rewards', (req, res) => {
  res.json(activeRewards().map((r) => ({ id: r.id, name: r.name, isNoWin: !!r.is_no_win })));
});

app.post('/api/spin', (req, res) => {
  // The customer's CleverTap Identity (their mobile number). `mobile` is still accepted for older links.
  const mobile = String(req.body?.identity || req.body?.mobile || '').replace(/[\s-]/g, '');
  if (!/^[\w+.@]{3,64}$/.test(mobile)) return res.status(400).json({ error: 'Invalid identity. Please open this page from the MyDialog app.' });

  try {
    const result = tx(() => {
      const s = getSettings();
      const since = new Date(Date.now() - s.cooldown_days * DAY_MS).toISOString();
      const prev = db.prepare(
        'SELECT created_at FROM spins WHERE mobile=? AND won=1 AND created_at>=? ORDER BY created_at DESC LIMIT 1'
      ).get(mobile, since);
      if (prev) {
        const next = new Date(new Date(prev.created_at).getTime() + s.cooldown_days * DAY_MS);
        return { status: 403, body: { error: `You have already won a reward. You can spin again on ${next.toDateString()}.` } };
      }

      const rewards = activeRewards();
      const capped = winsSince(startOfToday()) >= s.daily_cap || winsSince(startOfWeek()) >= s.weekly_cap;
      const stock = Object.fromEntries(
        db.prepare("SELECT reward_name n, COUNT(*) c FROM vouchers WHERE status='available' GROUP BY reward_name").all()
          .map((r) => [r.n, r.c])
      );
      const eligible = rewards.filter((r) => (r.is_no_win ? true : !capped && stock[r.name] > 0));
      const pick = pickWeighted(eligible) || rewards.find((r) => r.is_no_win);
      if (!pick) return { status: 503, body: { error: 'Wheel is not configured yet.' } };

      const now = new Date().toISOString();
      let code = null, type = '', value = '';
      if (!pick.is_no_win) {
        const v = db.prepare("SELECT id,code,reward_type,voucher_value FROM vouchers WHERE status='available' AND reward_name=? ORDER BY id LIMIT 1").get(pick.name);
        db.prepare("UPDATE vouchers SET status='allocated',allocated_to=?,allocated_at=? WHERE id=?").run(mobile, now, v.id);
        code = v.code; type = v.reward_type; value = v.voucher_value || pick.name;
      }
      db.prepare('INSERT INTO spins(mobile,reward_name,reward_type,voucher_code,voucher_value,won,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(mobile, pick.name, type, code, value, pick.is_no_win ? 0 : 1, now);

      return {
        status: 200,
        body: {
          segmentIndex: rewards.findIndex((r) => r.id === pick.id),
          reward: pick.name,
          won: !pick.is_no_win,
          voucherCode: code,
          voucherValue: value,
        },
      };
    });
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- admin ----------
function adminAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && token) {
    const [u, ...p] = Buffer.from(token, 'base64').toString().split(':');
    const a = Buffer.from(u + ':' + p.join(':')), b = Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Authentication required');
}
app.use(['/admin.html', '/admin.js', '/api/admin'], adminAuth);

app.get('/api/admin/settings', (req, res) => res.json(getSettings()));
app.put('/api/admin/settings', (req, res) => {
  for (const k of ['daily_cap', 'weekly_cap', 'cooldown_days']) {
    const n = Number(req.body?.[k]);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: `${k} must be a whole number ≥ 0` });
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, String(n));
  }
  res.json(getSettings());
});

app.get('/api/admin/summary', (req, res) => {
  res.json({
    winsToday: winsSince(startOfToday()),
    winsThisWeek: winsSince(startOfWeek()),
    totalSpins: db.prepare('SELECT COUNT(*) c FROM spins').get().c,
    stock: db.prepare(
      `SELECT r.name, COALESCE(SUM(v.status='available'),0) available, COALESCE(SUM(v.status='allocated'),0) allocated
       FROM rewards r LEFT JOIN vouchers v ON v.reward_name=r.name WHERE r.is_no_win=0 GROUP BY r.name`
    ).all(),
  });
});

app.get('/api/admin/rewards', (req, res) => res.json(db.prepare('SELECT id,name,weight,active,is_no_win FROM rewards ORDER BY id').all()));
app.put('/api/admin/rewards', (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected a list' });
  for (const r of list) {
    const w = Number(r.weight);
    if (!(w >= 0)) return res.status(400).json({ error: 'Weight must be ≥ 0' });
    db.prepare('UPDATE rewards SET weight=?,active=? WHERE id=?').run(w, r.active ? 1 : 0, r.id);
  }
  res.json({ ok: true });
});

app.post('/api/admin/vouchers', (req, res) => {
  if (typeof req.body !== 'string') return res.status(400).json({ error: 'Send CSV as text/csv' });
  const rows = parseCsv(req.body);
  if (rows.length && /^code$/i.test(rows[0][0].trim())) rows.shift(); // header
  let added = 0, duplicates = 0, invalid = 0;
  tx(() => {
    for (const [code, name, type, value] of rows) {
      if (!code?.trim() || !name?.trim()) { invalid++; continue; }
      db.prepare('INSERT OR IGNORE INTO rewards(name,weight) VALUES(?,1)').run(name.trim());
      const r = db.prepare('INSERT OR IGNORE INTO vouchers(code,reward_name,reward_type,voucher_value) VALUES(?,?,?,?)')
        .run(code.trim(), name.trim(), (type || '').trim(), (value || '').trim());
      r.changes ? added++ : duplicates++;
    }
  });
  res.json({ added, duplicates, invalid });
});

app.get('/api/admin/winners', (req, res) => {
  res.json(db.prepare('SELECT created_at,mobile,reward_name,reward_type,voucher_code,voucher_value FROM spins WHERE won=1 ORDER BY created_at DESC LIMIT 1000').all());
});
app.get('/api/admin/winners.csv', (req, res) => {
  // optional ?date=YYYY-MM-DD limits the report to that (server-local) day, e.g. an end-of-day report
  let from = '0000', to = '9999';
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) {
    const d = new Date(req.query.date + 'T00:00:00');
    from = d.toISOString();
    to = new Date(d.getTime() + DAY_MS).toISOString();
  }
  const rows = db.prepare('SELECT created_at,mobile,reward_name,reward_type,voucher_code,voucher_value FROM spins WHERE won=1 AND created_at>=? AND created_at<? ORDER BY created_at').all(from, to);
  const head = 'Date,Identity (Mobile Number),Voucher Code,Voucher Value,Reward,Reward Type';
  const body = rows.map((r) => [r.created_at, r.mobile, r.voucher_code, r.voucher_value || r.reward_name, r.reward_name, r.reward_type].map(csvEscape).join(','));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="winners-${new Date().toISOString().slice(0, 10)}.csv"`,
  }).send('﻿' + [head, ...body].join('\r\n'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Wheel:  http://localhost:${PORT}/`);
  console.log(`Admin:  http://localhost:${PORT}/admin.html  (user: ${ADMIN_USER})`);
  if (!process.env.ADMIN_PASS) console.warn('WARNING: using default admin password. Set ADMIN_PASS.');
});
