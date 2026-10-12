const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'wheel.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  reward_name TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  allocated_to TEXT,
  allocated_at TEXT
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  weight REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  is_no_win INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mobile TEXT NOT NULL,
  reward_name TEXT NOT NULL,
  reward_type TEXT NOT NULL DEFAULT '',
  voucher_code TEXT,
  won INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spins_mobile ON spins(mobile, won, created_at);
`);

// add voucher_value to databases created before this column existed
for (const t of ['vouchers', 'spins']) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'voucher_value')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN voucher_value TEXT NOT NULL DEFAULT ''`);
  }
}

const defaults = { daily_cap: '50', weekly_cap: '300', cooldown_days: '30' };
for (const [k, v] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}
if (db.prepare('SELECT COUNT(*) c FROM rewards').get().c === 0) {
  db.prepare('INSERT INTO rewards(name,weight,is_no_win) VALUES(?,?,1)').run('Better luck next time', 5);
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = Number(r.value);
  return out;
}

// Runs fn inside an immediate (write-locked) transaction so concurrent spins serialise.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, getSettings, tx };
