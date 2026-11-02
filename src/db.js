const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'gretchen.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, chat_id TEXT, plan TEXT NOT NULL DEFAULT 'free', expires_at INTEGER, greeted INTEGER NOT NULL DEFAULT 0, state TEXT, pending_plan TEXT, reminded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage(user_id TEXT, day TEXT, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, role TEXT, content TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_messages_key ON messages(key, id);
CREATE TABLE IF NOT EXISTS payments(reference TEXT PRIMARY KEY, user_id TEXT, chat_id TEXT, plan TEXT, amount REAL, phone TEXT, poll_url TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, paid_at INTEGER);
CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, ts INTEGER);
`);

const COLS = ['chat_id', 'plan', 'expires_at', 'greeted', 'state', 'pending_plan', 'reminded'];
const day = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // Zimbabwe day (UTC+2)

function getUser(id) {
  let u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) {
    db.prepare('INSERT INTO users(id, created_at) VALUES(?,?)').run(id, Date.now());
    u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  return u;
}
function setUser(id, fields) {
  const keys = Object.keys(fields).filter(k => COLS.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE users SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
}
function usageToday(id) {
  const r = db.prepare('SELECT count FROM usage WHERE user_id=? AND day=?').get(id, day());
  return r ? r.count : 0;
}
function bumpUsage(id) {
  db.prepare('INSERT INTO usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').run(id, day());
}
function addMessage(key, role, content) {
  db.prepare('INSERT INTO messages(key,role,content,ts) VALUES(?,?,?,?)').run(key, role, content, Date.now());
  db.prepare('DELETE FROM messages WHERE key=? AND id NOT IN (SELECT id FROM messages WHERE key=? ORDER BY id DESC LIMIT 30)').run(key, key);
}
function history(key, n = 10) {
  return db.prepare('SELECT role,content FROM messages WHERE key=? ORDER BY id DESC LIMIT ?').all(key, n).reverse();
}
function firstSeen(id) {
  const r = db.prepare('INSERT OR IGNORE INTO seen(id,ts) VALUES(?,?)').run(id, Date.now());
  if (Math.random() < 0.01) db.prepare('DELETE FROM seen WHERE ts<?').run(Date.now() - 86400000);
  return r.changes === 1;
}
module.exports = { db, getUser, setUser, usageToday, bumpUsage, addMessage, history, firstSeen };
