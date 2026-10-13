// Spin the Wheel admin console (single page, hash-routed).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// X-STW-Admin marks requests from this console; the server refuses changes without it (blocks cross-site use).
const api = (url, opts = {}) => fetch(url, { ...opts, headers: { 'X-STW-Admin': '1', ...opts.headers } }).then(async (r) => {
  const d = await r.json().catch(() => {
    throw new Error(`Server unavailable (HTTP ${r.status}). The backend function may be down - try again shortly.`);
  });
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
});
const send = (url, method, body) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmtNum = (n) => Number(n || 0).toLocaleString();
const SETTINGS = ['daily_cap', 'weekly_cap', 'cooldown_days', 'spins_per_day', 'spins_per_week', 'low_stock_pct'];
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const TEMPLATES = [
  { file: 'wheel-dialogpay.html', type: 'wheel', name: 'Spin the Wheel - Dialog Pay', desc: 'The finished Dialog Pay wheel: red header, studded rim, receipt-style result.' },
  { file: 'wheel-refined-plus.html', type: 'wheel', name: 'Spin the Wheel - Refined Plus', desc: 'Pink-to-purple gradient wheel with a soft, polished feel.' },
  { file: 'wheel-neon.html', type: 'wheel', name: 'Spin the Wheel - Neon', desc: 'Bold neon look with a glowing border and gradient buttons.' },
  { file: 'wheel-classic.html', type: 'wheel', name: 'Spin the Wheel - Classic', desc: 'The original simple wheel with a bright gradient card.' },
  { file: 'game-scratch-card.html', type: 'game', name: 'Scratch Card', desc: 'Scratch the silver foil with a finger to reveal the prize.' },
  { file: 'game-gift-box.html', type: 'game', name: 'Mystery Gift Box', desc: 'Pick 1 of 3 boxes; the lid flies off to show the prize.' },
  { file: 'game-flip-card.html', type: 'game', name: 'Flip the Card', desc: 'Pick 1 of 6 face-down cards and flip it over.' },
  { file: 'game-slot-machine.html', type: 'game', name: 'Slot Machine', desc: 'Three reels; three of a kind wins the prize.' },
];
let me = null, settings = null, summary = null, rewards = [], rewardsSaved = '', winners = [], paused = false;
const isAdmin = () => me && me.role === 'admin';

// ---------- feedback: toasts, confirm dialog, button loading ----------
function toast(text, kind) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 6000 : 3500);
}
const fail = (e) => toast(e.message || String(e), 'bad');
function confirmBox({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="cbTitle"><h3 id="cbTitle">${esc(title)}</h3><p>${esc(body)}</p>
      <div class="actions"><button class="btn secondary" data-a="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="1">${esc(ok)}</button></div></div>`;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    back.addEventListener('click', (e) => { if (e.target === back) done(false); const a = e.target.closest('[data-a]'); if (a) done(a.dataset.a === '1'); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    back.querySelector('[data-a="1"]').focus();
  });
}
async function busy(btn, work) {
  btn.classList.add('loading');
  try { return await work(); } finally { btn.classList.remove('loading'); }
}

// ---------- routing ----------
const VIEWS = ['dashboard', 'games', 'studio', 'prizes', 'rules', 'customers', 'winners', 'team', 'activity'];
const loaded = {};
function route() {
  const [name, query] = (location.hash.slice(1) || 'dashboard').split('?');
  const view = VIEWS.includes(name) && !(name === 'team' && !isAdmin()) ? name : 'dashboard';
  VIEWS.forEach((v) => ($('view-' + v).hidden = v !== view));
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view || (view === 'studio' && a.dataset.view === 'games')));
  document.body.classList.remove('nav-open');
  window.scrollTo(0, 0);
  if (view === 'games' && !loaded.games) { loaded.games = true; buildGallery(); }
  if (view === 'studio') {
    const t = new URLSearchParams(query || '').get('t') || TEMPLATES[0].file;
    const src = 'studio.html?embed=1&t=' + encodeURIComponent(t);
    if ($('studioFrame').getAttribute('src') !== src) $('studioFrame').setAttribute('src', src);
  }
  if (view === 'team' && !loaded.team) { loaded.team = true; loadUsers(); }
  if (view === 'activity') loadAudit();
}
window.addEventListener('hashchange', route);
$('menuBtn').onclick = () => document.body.classList.toggle('nav-open');

// ---------- load everything ----------
async function load() {
  // One request first, so the browser asks for the admin login once rather than once per call.
  me = await api('/api/admin/me');
  $('who').textContent = me.user;
  $('avatar').textContent = me.user.slice(0, 1);
  $('roleText').textContent = me.role === 'admin' ? (me.owner ? 'Owner' : 'Admin') : 'Viewer - read only';
  document.body.classList.toggle('viewer', !isAdmin());
  if (!isAdmin()) document.querySelectorAll('#view-rules input, #view-prizes input').forEach((el) => (el.disabled = true));
  route();
  const [s, sum, rw, win] = await Promise.all([
    api('/api/admin/settings'), api('/api/admin/summary'), api('/api/admin/rewards'), api('/api/admin/winners'),
  ]);
  settings = s; summary = sum; winners = win;
  fillSettings(); fillSchedule();
  showOverview();
  setRewards(rw);
  renderWinners();
  loadAnalytics();
}
async function refreshSummary() {
  summary = await api('/api/admin/summary');
  showOverview();
  renderRewards();
}

// ---------- overview: status, pause, KPIs, stock ----------
function showOverview() {
  const st = summary.status;
  paused = summary.paused;
  const pill = $('wheelStatus');
  pill.className = 'status-pill ' + (st.open ? 'open' : 'closed');
  pill.textContent = st.open ? 'Live' + (st.closes_at ? ` · closes ${st.closes_at}` : '') : paused ? 'Paused' : 'Closed';
  pill.title = st.open ? 'Customers can play now' : st.message || '';
  const pb = $('pauseBtn');
  pb.hidden = false;
  pb.className = 'btn sm admin-only ' + (paused ? 'primary' : 'danger-soft');
  pb.innerHTML = paused
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>Resume</span>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Pause</span>';
  $('statusAlert').hidden = st.open;
  $('statusAlert').textContent = paused ? 'The games are paused - the popup closes by itself until you resume.' : 'Closed right now - customers see nothing. ' + (st.message || '');
  const rate = summary.spinsToday ? Math.round((summary.winsToday / summary.spinsToday) * 100) + '%' : '-';
  $('stats').innerHTML = [
    ['Plays today', fmtNum(summary.spinsToday), ''],
    ['Winners today', fmtNum(summary.winsToday), settings ? `cap ${settings.daily_cap ? fmtNum(settings.daily_cap) : 'none'}` : ''],
    ['Win rate today', rate, 'winners ÷ plays'],
    ['Winners this week', fmtNum(summary.winsThisWeek), settings ? `cap ${settings.weekly_cap ? fmtNum(settings.weekly_cap) : 'none'}` : ''],
    ['Total plays', fmtNum(summary.totalSpins), 'since launch'],
  ].map(([l, v, s]) => `<div class="kpi"><span>${l}</span><b>${v}</b><small>${esc(s)}</small></div>`).join('');
  const warn = summary.stock.filter((r) => r.active && r.level);
  $('stockAlert').hidden = !warn.length;
  $('stockAlert').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><span>' +
    warn.map((r) => `<b>${esc(r.name)}</b> ${r.level === 'out' ? 'is out of vouchers' : `has only ${r.available} left`}`).join('; ') +
    `. <a href="#prizes">Upload more vouchers</a></span>`;
  $('stockBadge').hidden = !warn.length;
  $('stockBadge').textContent = warn.length;
  const meter = (r) => {
    const total = r.available + r.allocated + r.expired, pct = total ? Math.round((r.available / total) * 100) : 0;
    return `<div class="meter ${r.level}"><i><b style="width:${pct}%"></b></i><span>${pct}%</span></div>`;
  };
  const level = (r) => (r.level === 'out' ? '<span class="tag bad">Out of stock</span>' : r.level === 'low' ? '<span class="tag warn">Low</span>' : '<span class="tag ok">OK</span>');
  const rows = summary.stock;
  $('stockMini').innerHTML = '<tr><th>Reward</th><th class="num">Left</th><th>Stock</th></tr>' + (rows.length
    ? rows.map((r) => `<tr><td>${esc(r.name)}${r.active ? '' : ' <span class="tag neutral">hidden</span>'}</td><td class="num">${fmtNum(r.available)}</td><td>${meter(r)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">No vouchers yet.</td></tr>');
  $('stock').innerHTML = '<tr><th>Reward</th><th class="num">Available</th><th class="num">Given out</th><th class="num">Expired</th><th>Status</th></tr>' + (rows.length
    ? rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmtNum(r.available)}</td><td class="num">${fmtNum(r.allocated)}</td><td class="num">${fmtNum(r.expired)}</td><td>${level(r)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No vouchers yet - upload a CSV.</td></tr>');
  $('updatedAt').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · refreshes every minute';
}
$('pauseBtn').onclick = async () => {
  if (!paused && !(await confirmBox({ title: 'Pause all games now?', body: 'Customers will not see the popup until you resume. Use this in an emergency.', ok: 'Pause now', danger: true }))) return;
  busy($('pauseBtn'), () => send('/api/admin/pause', 'PUT', { paused: !paused }))
    .then(() => { toast(paused ? 'Games resumed' : 'Games paused', 'ok'); return refreshSummary(); }).catch(fail);
};
$('refreshBtn').onclick = () => busy($('refreshBtn'), () => Promise.all([refreshSummary(), loadAnalytics()])).catch(fail);
setInterval(() => { if (!$('view-dashboard').hidden && document.visibilityState === 'visible') { refreshSummary().catch(() => {}); loadAnalytics(); } }, 60000);

// ---------- analytics ----------
function barChart(chartId, axisId, items, labelEvery) {
  const max = Math.max(1, ...items.map((i) => i.value));
  $(chartId).innerHTML = items.map((i) => `<div class="col" data-tip="${esc(i.tip)}"><div class="bar" style="height:${(i.value / max) * 100}%"></div></div>`).join('');
  $(axisId).innerHTML = items.map((i, k) => `<span>${k % labelEvery === 0 ? esc(i.label) : ''}</span>`).join('');
}
const shortDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
async function loadAnalytics() {
  try {
    const a = await api('/api/admin/analytics?days=' + $('anDays').value);
    const every = Math.ceil(a.days.length / 7);
    barChart('chSpins', 'axSpins', a.days.map((d) => ({ value: d.spins, label: shortDate(d.date), tip: `${shortDate(d.date)}: ${d.spins} plays` })), every);
    barChart('chWins', 'axWins', a.days.map((d) => ({ value: d.wins, label: shortDate(d.date), tip: `${shortDate(d.date)}: ${d.wins} winners` })), every);
    const hh = (h) => String(h).padStart(2, '0');
    barChart('chHours', 'axHours', a.hoursToday.map((v, h) => ({ value: v, label: hh(h), tip: `${hh(h)}:00-${hh(h)}:59: ${v} plays` })), 4);
    const total = Object.values(a.byReward).reduce((x, y) => x + y, 0);
    const rows = Object.entries(a.byReward).sort((x, y) => y[1] - x[1]);
    $('anRewards').innerHTML = '<tr><th>Reward</th><th class="num">Wins</th><th>Share</th></tr>' + (rows.length
      ? rows.map(([n, c]) => { const p = Math.round((c / total) * 100); return `<tr><td>${esc(n)}</td><td class="num">${c}</td><td><div class="meter"><i><b style="width:${p}%"></b></i><span>${p}%</span></div></td></tr>`; }).join('')
      : '<tr><td colspan="3" class="empty">No wins in this period yet.</td></tr>');
    $('anTable').innerHTML = '<tr><th>Date</th><th class="num">Plays</th><th class="num">Winners</th><th class="num">Win rate</th></tr>' +
      a.days.slice().reverse().map((d) => `<tr><td>${esc(d.date)}</td><td class="num">${d.spins}</td><td class="num">${d.wins}</td><td class="num">${d.spins ? Math.round((d.wins / d.spins) * 100) + '%' : '-'}</td></tr>`).join('');
  } catch (e) { console.error(e); }
}
$('anDays').onchange = loadAnalytics;

// ---------- games gallery ----------
function buildGallery() {
  $('gallery').innerHTML = TEMPLATES.map((t) => `
    <article class="game-card" data-type="${t.type}">
      <div class="thumb" tabindex="0" role="button" aria-label="Preview ${esc(t.name)}" data-preview="${t.file}">
        <iframe data-src="${t.file}" title="${esc(t.name)} thumbnail" tabindex="-1" loading="lazy"></iframe>
        <div class="play"><span>▶ Try it</span></div>
      </div>
      <div class="game-body">
        <span><span class="tag ${t.type === 'wheel' ? 'brand' : 'neutral'}">${t.type === 'wheel' ? 'Wheel' : 'New game'}</span></span>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.desc)}</p>
        <div class="game-actions">
          <button class="btn secondary sm" data-preview="${t.file}">Preview</button>
          <a class="btn primary sm" href="#studio?t=${encodeURIComponent(t.file)}">Customise</a>
          <button class="btn secondary sm icon" data-download="${t.file}" title="Download HTML" aria-label="Download ${esc(t.name)} HTML"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg></button>
        </div>
      </div>
    </article>`).join('');
  // Load the live thumbnails only when they scroll into view.
  const frames = [...$('gallery').querySelectorAll('iframe[data-src]')];
  const show = (f) => { if (!f.src) f.src = f.dataset.src; };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }), { rootMargin: '200px' });
    frames.forEach((f) => io.observe(f));
  } else frames.forEach(show);
  $('gallery').addEventListener('click', (e) => {
    const p = e.target.closest('[data-preview]'), d = e.target.closest('[data-download]');
    if (p) previewModal(p.dataset.preview);
    if (d) download(d.dataset.download);
  });
  $('gallery').addEventListener('keydown', (e) => { const p = e.target.closest('.thumb'); if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); previewModal(p.dataset.preview); } });
}
$('gameFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('gameFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.game-card').forEach((c) => (c.hidden = b.dataset.filter !== 'all' && c.dataset.type !== b.dataset.filter));
});
function previewModal(file) {
  const t = TEMPLATES.find((x) => x.file === file);
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal-box wide" role="dialog" aria-modal="true" aria-label="Preview ${esc(t.name)}">
    <div class="preview-close"><span>${esc(t.name)} · demo round</span><button aria-label="Close preview">✕</button></div>
    <div class="preview-phone"><iframe src="${file}" title="${esc(t.name)} preview"></iframe></div></div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.preview-close button')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  back.querySelector('.preview-close button').focus();
}
async function download(file) {
  try {
    const html = await (await fetch(file, { cache: 'no-store' })).text();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = 'clevertap-' + file.replace(/^(wheel|game)-/, '');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Downloaded - paste it into CleverTap Custom HTML', 'ok');
  } catch (e) { fail(e); }
}

// ---------- prizes: segments with live win chances ----------
function setRewards(rw) {
  rewards = rw.map((r) => ({ ...r }));
  rewardsSaved = JSON.stringify(rewards);
  renderRewards();
  rewardsChanged();
}
function chances() {
  const stock = Object.fromEntries((summary ? summary.stock : []).map((s) => [s.name, s.available]));
  const can = (r) => r.active && (r.is_no_win || (stock[r.name] || 0) > 0);
  const total = rewards.reduce((s, r) => s + (can(r) ? Number(r.weight) || 0 : 0), 0);
  return rewards.map((r) => (can(r) && total > 0 ? ((Number(r.weight) || 0) / total) * 100 : null));
}
function renderRewards() {
  if (!rewards.length) { $('rewards').innerHTML = '<tr><td class="empty">No segments yet.</td></tr>'; return; }
  const stock = Object.fromEntries((summary ? summary.stock : []).map((s) => [s.name, s]));
  const dis = isAdmin() ? '' : ' disabled';
  $('rewards').innerHTML = '<tr><th>Segment</th><th>Weight</th><th>Win chance</th><th>Daily limit</th><th class="num">Vouchers left</th><th>Active</th></tr>' + rewards.map((r, i) => {
    const s = stock[r.name];
    return `<tr>
      <td><b>${esc(r.name)}</b>${r.is_no_win ? ' <span class="tag neutral">no win</span>' : ''}</td>
      <td><input type="number" min="0" step="any" data-i="${i}" data-f="weight" value="${esc(r.weight)}" aria-label="Weight for ${esc(r.name)}"${dis}></td>
      <td><div class="meter"><i><b data-chance-bar="${i}"></b></i><span data-chance="${i}"></span></div></td>
      <td>${r.is_no_win ? '<span class="muted">-</span>' : `<input type="number" min="0" step="1" data-i="${i}" data-f="daily_limit" value="${esc(r.daily_limit)}" aria-label="Daily limit for ${esc(r.name)}" placeholder="0"${dis}>`}</td>
      <td class="num">${r.is_no_win ? '<span class="muted">-</span>' : s ? `${fmtNum(s.available)}${s.level === 'out' ? ' <span class="tag bad">out</span>' : s.level === 'low' ? ' <span class="tag warn">low</span>' : ''}` : '0'}</td>
      <td><label class="switch"><input type="checkbox" data-i="${i}" data-f="active" ${r.active ? 'checked' : ''} aria-label="${esc(r.name)} active"${dis}><i></i></label></td>
    </tr>`;
  }).join('');
  updateChances();
}
function updateChances() {
  chances().forEach((c, i) => {
    const t = document.querySelector(`[data-chance="${i}"]`), b = document.querySelector(`[data-chance-bar="${i}"]`);
    if (!t) return;
    t.textContent = c === null ? 'skipped' : (c < 1 && c > 0 ? '<1' : Math.round(c)) + '%';
    b.style.width = (c || 0) + '%';
  });
}
function rewardsChanged() {
  const dirty = JSON.stringify(rewards) !== rewardsSaved;
  $('rewardsDirty').hidden = !dirty;
  $('saveRewards').disabled = !dirty;
  $('resetRewards').disabled = !dirty;
}
$('rewards').addEventListener('input', (e) => {
  const el = e.target.closest('[data-i]'); if (!el) return;
  const r = rewards[el.dataset.i];
  r[el.dataset.f] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
  updateChances(); rewardsChanged();
});
$('resetRewards').onclick = () => setRewards(JSON.parse(rewardsSaved));
$('saveRewards').onclick = async () => {
  const noWin = rewards.find((r) => r.is_no_win);
  if (noWin && !noWin.active && !(await confirmBox({ title: 'Hide "Better luck next time"?', body: 'Every play will then give a prize until the vouchers run out.', ok: 'Save anyway', danger: true }))) return;
  if (rewards.some((r) => !(Number(r.weight) >= 0) || !Number.isInteger(Number(r.daily_limit || 0)) || Number(r.daily_limit || 0) < 0)) return toast('Weights must be 0 or more, and daily limits whole numbers.', 'bad');
  busy($('saveRewards'), () => send('/api/admin/rewards', 'PUT', rewards))
    .then(async () => { toast('Segments saved', 'ok'); setRewards(await api('/api/admin/rewards')); }).catch(fail);
};

// ---------- vouchers upload ----------
let csvText = null;
async function pickFile(f) {
  if (!f) return;
  if (!/\.csv$/i.test(f.name)) return toast('Please choose a .csv file', 'bad');
  csvText = await f.text();
  const rows = csvText.split(/\r?\n/).filter((l) => l.trim()).length - (/^\s*code\s*,/i.test(csvText) ? 1 : 0);
  $('fileName').innerHTML = `<b>${esc(f.name)}</b> · ${fmtNum(rows)} voucher${rows === 1 ? '' : 's'}`;
  $('fileInfo').hidden = false;
  $('upload').disabled = false;
}
function clearFile() { csvText = null; $('csvFile').value = ''; $('fileInfo').hidden = true; $('upload').disabled = true; }
$('csvFile').onchange = () => pickFile($('csvFile').files[0]);
$('clearFile').onclick = (e) => { e.preventDefault(); clearFile(); };
const dz = $('dropzone');
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('csvFile').click(); } });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));
$('upload').onclick = () => {
  if (!csvText) return;
  busy($('upload'), () => api('/api/admin/vouchers', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csvText }))
    .then(async (r) => {
      toast(`Added ${fmtNum(r.added)} vouchers` + (r.duplicates ? ` · ${r.duplicates} duplicates skipped` : '') + (r.invalid ? ` · ${r.invalid} invalid rows` : ''), r.added ? 'ok' : '');
      clearFile();
      const [rw] = await Promise.all([api('/api/admin/rewards'), refreshSummary()]);
      setRewards(rw);
    }).catch(fail);
};

// ---------- rules: schedule + limits ----------
$('sc_days').innerHTML = DAYS.map(([d, n]) => `<label class="chip"><input type="checkbox" value="${d}"><span>${n}</span></label>`).join('');
const scheduleForm = () => ({
  enabled: $('sc_enabled').checked, start_date: $('sc_start').value, end_date: $('sc_end').value,
  from: $('sc_from').value, to: $('sc_to').value,
  days: [...document.querySelectorAll('#sc_days input:checked')].map((el) => Number(el.value)).sort(),
});
let scheduleSaved = '';
function fillSchedule() {
  const sc = settings.schedule;
  $('sc_enabled').checked = !!sc.enabled;
  $('sc_start').value = sc.start_date || ''; $('sc_end').value = sc.end_date || '';
  $('sc_from').value = sc.from || ''; $('sc_to').value = sc.to || '';
  document.querySelectorAll('#sc_days input').forEach((el) => (el.checked = sc.days.includes(Number(el.value))));
  if (!isAdmin()) document.querySelectorAll('#view-rules input').forEach((el) => (el.disabled = true));
  scheduleSaved = JSON.stringify(scheduleForm());
  scheduleChanged();
}
function scheduleChanged() {
  const dirty = JSON.stringify(scheduleForm()) !== scheduleSaved;
  $('scheduleDirty').hidden = !dirty;
  $('saveSchedule').disabled = !dirty;
  $('scheduleFields').style.opacity = $('sc_enabled').checked ? '' : '.5';
}
$('view-rules').addEventListener('input', (e) => { if (e.target.closest('.card') === $('saveSchedule').closest('.card')) scheduleChanged(); else settingsChanged(); });
$('view-rules').addEventListener('change', (e) => { if (e.target.closest('.card') === $('saveSchedule').closest('.card')) scheduleChanged(); });
$('saveSchedule').onclick = () =>
  busy($('saveSchedule'), () => send('/api/admin/schedule', 'PUT', scheduleForm()))
    .then((r) => { settings.schedule = r.schedule; fillSchedule(); toast('Schedule saved', 'ok'); return refreshSummary(); }).catch(fail);

let settingsSaved = '';
function fillSettings() {
  SETTINGS.forEach((k) => ($(k).value = settings[k]));
  settingsSaved = JSON.stringify(SETTINGS.map((k) => String($(k).value)));
  settingsChanged();
}
function settingsChanged() {
  let valid = true;
  SETTINGS.forEach((k) => {
    const v = $(k).value, n = Number(v), ok = v !== '' && Number.isInteger(n) && n >= 0 && (k !== 'low_stock_pct' || n <= 100);
    $(k).classList.toggle('invalid', !ok);
    valid = valid && ok;
  });
  const dirty = JSON.stringify(SETTINGS.map((k) => String($(k).value))) !== settingsSaved;
  $('settingsDirty').hidden = !dirty;
  $('settingsDirty').textContent = valid ? 'Unsaved changes' : 'Fix the highlighted values';
  $('saveSettings').disabled = !dirty || !valid;
}
$('saveSettings').onclick = () =>
  busy($('saveSettings'), () => send('/api/admin/settings', 'PUT', Object.fromEntries(SETTINGS.map((k) => [k, $(k).value]))))
    .then((s) => { settings = s; fillSettings(); toast('Limits saved', 'ok'); return refreshSummary(); }).catch(fail);

// ---------- customers ----------
async function lookup() {
  const m = $('lookupMobile').value.trim();
  if (!m) return;
  $('lookupResult').innerHTML = '<p class="empty"><span class="skeleton"></span></p>';
  try {
    const c = await api('/api/admin/customer?mobile=' + encodeURIComponent(m));
    $('lookupResult').innerHTML = `
      <div class="profile">
        <span class="avatar">${esc(c.mobile.slice(-2))}</span>
        <div style="flex:1;min-width:200px"><h3 class="mono">${esc(c.mobile)}</h3>
          <div class="muted">${c.canSpin ? '<span class="tag ok">Can play</span>' : '<span class="tag bad">Can\'t play now</span>'} ${esc(c.message)}</div>
          <div class="muted" style="margin-top:4px">Plays today: <b>${c.spinsToday}</b> · this week: <b>${c.spinsThisWeek}</b> · wins: <b>${c.wins.length}</b></div></div>
        <button class="btn secondary admin-only" id="testLink">Copy test link</button>
        <button class="btn secondary admin-only" id="resetCustomer">Let them play again</button>
      </div>
      <div class="table-wrap"><table><tr><th>Date</th><th>Reward</th><th>Voucher code</th><th>Value</th><th>Expires</th></tr>${c.wins.length
        ? c.wins.map((w) => `<tr><td>${new Date(w.created_at).toLocaleString()}</td><td>${esc(w.reward_name)}</td><td class="mono"><b>${esc(w.voucher_code)}</b></td><td>${esc(w.voucher_value)}</td><td>${esc(w.expiry_date || '-')}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">No wins yet.</td></tr>'}</table></div>`;
    const tl = $('testLink');
    if (tl) tl.onclick = () => busy(tl, () => api('/api/admin/test-token?mobile=' + encodeURIComponent(c.mobile))).then(async (t) => {
      const url = location.origin + '/?identity=' + encodeURIComponent(t.identity) + '&token=' + encodeURIComponent(t.token);
      await navigator.clipboard.writeText(url);
      toast('Test link copied - it plays as this customer', 'ok');
    }).catch(fail);
    const btn = $('resetCustomer');
    if (btn) btn.onclick = async () => {
      if (!(await confirmBox({ title: `Let ${c.mobile} play again?`, body: 'This clears their winner cooldown and play count. Their past wins stay in the reports.', ok: 'Reset' }))) return;
      busy(btn, () => send('/api/admin/customer/reset', 'POST', { mobile: c.mobile })).then(() => { toast('Customer reset', 'ok'); lookup(); }).catch(fail);
    };
  } catch (e) { $('lookupResult').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}
$('lookupBtn').onclick = lookup;
$('lookupMobile').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookup(); });

// ---------- winners ----------
function renderWinners() {
  const q = $('winnerFilter').value.trim().toLowerCase();
  const list = q ? winners.filter((w) => [w.mobile_masked, w.voucher_code, w.reward_name].some((v) => String(v || '').toLowerCase().includes(q))) : winners;
  $('winnersCount').textContent = q ? `${fmtNum(list.length)} of ${fmtNum(winners.length)} winners match.` : `Latest ${fmtNum(winners.length)} winners.`;
  $('winners').innerHTML = '<tr><th>Date</th><th>Mobile</th><th>Voucher code</th><th>Value</th><th>Reward</th><th>Expires</th></tr>' + (list.length
    ? list.slice(0, 500).map((w) => `<tr><td>${new Date(w.created_at).toLocaleString()}</td><td class="mono">${esc(w.mobile_masked)}</td><td class="mono">${esc(w.voucher_code)}</td><td>${esc(w.voucher_value || w.reward_name)}</td><td>${esc(w.reward_name)}</td><td>${esc(w.expiry_date || '-')}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${q ? 'No winners match your filter.' : 'No winners yet.'}</td></tr>`);
}
$('winnerFilter').addEventListener('input', renderWinners);
$('reportDate').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
$('dlDay').onclick = (e) => { e.preventDefault(); location.href = '/api/admin/winners.csv?date=' + encodeURIComponent($('reportDate').value); };

// ---------- team ----------
async function loadUsers() {
  try {
    const list = await api('/api/admin/users');
    $('users').innerHTML = '<tr><th>User</th><th>Role</th><th>Added</th><th></th></tr>' + list.map((u) =>
      `<tr><td><b>${esc(u.username)}</b>${u.username === me.user ? ' <span class="tag brand">you</span>' : ''}</td>
       <td>${u.owner ? '<span class="tag brand">Owner</span>' : u.role === 'admin' ? '<span class="tag ok">Admin</span>' : '<span class="tag neutral">Viewer</span>'}</td>
       <td class="muted">${u.created_at ? esc(new Date(u.created_at).toLocaleDateString() + ' by ' + u.created_by) : 'Server configuration'}</td>
       <td class="num">${u.owner || u.username === me.user ? '' : `<button class="btn danger-soft sm" data-del="${esc(u.username)}">Remove</button>`}</td></tr>`).join('');
  } catch (e) { fail(e); }
}
$('users').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (!(await confirmBox({ title: `Remove ${b.dataset.del}?`, body: 'They will no longer be able to sign in.', ok: 'Remove', danger: true }))) return;
  busy(b, () => api('/api/admin/users/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' })).then(() => { toast('Account removed', 'ok'); loadUsers(); }).catch(fail);
});
$('addUser').onclick = () =>
  busy($('addUser'), () => send('/api/admin/users', 'POST', { username: $('newUser').value, password: $('newPass').value, role: $('newRole').value }))
    .then(() => { toast(`Account ${$('newUser').value.trim().toLowerCase()} saved`, 'ok'); $('newUser').value = $('newPass').value = ''; loadUsers(); }).catch(fail);

// ---------- activity ----------
async function loadAudit() {
  try {
    const list = await api('/api/admin/audit');
    const fmt = (d) => Object.entries(d || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    $('audit').innerHTML = '<tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>' + (list.length
      ? list.map((e) => `<tr><td style="white-space:nowrap">${new Date(e.at).toLocaleString()}</td><td><b>${esc(e.user)}</b></td><td>${esc(e.action)}</td><td class="muted">${esc(fmt(e.details))}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No changes yet.</td></tr>');
  } catch (e) { console.error(e); }
}

route();
load().catch(fail);
