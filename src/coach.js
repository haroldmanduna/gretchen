// Teacher coaching for one watched group.
// Gretchen keeps a rolling 7-day log of the group so it knows what is happening.
// It only checks the teacher's answers, sends the teacher a private note after each answer,
// and posts in the group only when the answer is clearly unclear or wrong, within strict limits.
const { db } = require('./db');
const { ask } = require('./ai');
const waha = require('./waha');
const { toWhatsAppText } = require('./waha');

db.exec(`
CREATE TABLE IF NOT EXISTS group_msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, msg_id TEXT, sender TEXT, name TEXT, body TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_group_msgs_chat ON group_msgs(chat_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_msgs_msg ON group_msgs(msg_id);
CREATE TABLE IF NOT EXISTS coach_log(msg_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, stepped_in INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS coach_kv(k TEXT PRIMARY KEY, v TEXT);
`);

const WATCH_GROUP = process.env.WATCH_GROUP_ID || '120363432355067865@g.us';
const TEACHER = String(process.env.TEACHER_PHONE || '263777441482').replace(/\D/g, '');
const KEEP_MS = 7 * 86400000;
const CONTEXT = 20;              // recent group messages the AI sees
const MAX_STEPINS_PER_DAY = 2;   // group posts per day
const STEPIN_GAP_MS = 2 * 3600000;
const MAX_ANALYSES_PER_DAY = 60; // AI checks per day, to protect free quotas
const MIN_WORDS = 6;             // ignore "ok", "yes", "thanks"

const day = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10); // Zimbabwe day
const kvGet = (k) => db.prepare('SELECT v FROM coach_kv WHERE k=?').get(k)?.v ?? null;
const kvSet = (k, v) => db.prepare('INSERT INTO coach_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const kvNum = (k) => Number(kvGet(k) || 0);

const COACH_SYSTEM = `You coach a teacher who runs an AI literacy WhatsApp group for people in Zimbabwe.
You will see the most recent group messages, oldest first. The TEACHER's last message is the answer to check.
Decide:
- is_answer: true only if the TEACHER's last message answers a question or request from a group member.
- quality: "good" (clear, correct, suited to the people asking), "unclear" (confusing, too advanced, missing a step), "wrong" (factually wrong), or "not_answer".
- feedback: 2 to 4 sentences to the teacher in plain English. Say what worked, then give one better way to explain it (a simpler example or step-by-step). Be kind and specific.
- step_in: true ONLY when quality is "unclear" or "wrong" and a short group message would clearly help the members. Otherwise false.
- group_message: only when step_in is true. Write a short, polite message to the whole group (under 60 words) that gives the clearer explanation or the correction. Do not name or blame the teacher. Do not say "the teacher".
Reply with JSON only, no other text: {"is_answer":true,"quality":"good","feedback":"...","step_in":false,"group_message":""}
Plain text only: no markdown, no ** stars, no # headings.`;

function parseJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function canStepIn() {
  if (kvNum(`stepins_${day()}`) >= MAX_STEPINS_PER_DAY) return false;
  const last = kvNum('last_stepin_ts');
  return !last || Date.now() - last >= STEPIN_GAP_MS;
}

async function analyse(recent) {
  const transcript = recent.map(m => `${m.sender === TEACHER ? 'TEACHER' : (m.name || 'member')}: ${m.body}`).join('\n');
  const msgs = [{ role: 'user', content: `Recent group messages, oldest first:\n\n${transcript}` }];
  const raw = await ask(msgs, COACH_SYSTEM);
  return parseJson(raw);
}

// Called for every group message from the watched group (tagged or not).
async function watch(p, chatId, sender, text) {
  if (chatId !== WATCH_GROUP) return;
  const msgId = String(p.id || '');
  if (!msgId) return;
  const name = String(p._data?.notifyName || p.pushName || '').trim().slice(0, 40) || `member ${sender.slice(-4)}`;
  const saved = db.prepare('INSERT OR IGNORE INTO group_msgs(chat_id,msg_id,sender,name,body,ts) VALUES(?,?,?,?,?,?)')
    .run(chatId, msgId, sender, name, text, Date.now());
  if (saved.changes !== 1) return; // duplicate delivery

  if (sender !== TEACHER) return;                       // only the teacher's answers are checked
  if (text.split(/\s+/).length < MIN_WORDS) return;     // short acknowledgements are skipped

  const recent = db.prepare('SELECT sender,name,body FROM group_msgs WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, CONTEXT).reverse();
  const earlier = recent.slice(0, -1);
  if (!earlier.some(m => m.sender !== TEACHER && m.body.includes('?'))) return; // nothing was asked

  if (kvNum(`analyses_${day()}`) >= MAX_ANALYSES_PER_DAY) return;
  kvSet(`analyses_${day()}`, kvNum(`analyses_${day()}`) + 1);
  db.prepare('INSERT OR IGNORE INTO coach_log(msg_id,ts,stepped_in) VALUES(?,?,0)').run(msgId, Date.now());

  const result = await analyse(recent);
  if (!result || result.is_answer !== true) return;

  const canPost = result.step_in === true && (result.quality === 'unclear' || result.quality === 'wrong')
    && result.group_message && canStepIn();
  const note = canPost
    ? '\n\nI have posted a short clarification in the group.'
    : '\n\nI have not posted anything in the group.';
  const feedback = toWhatsAppText(String(result.feedback || '').trim()).slice(0, 900) + note;
  await waha.reply(`${TEACHER}@c.us`, feedback);

  if (canPost) {
    const groupText = toWhatsAppText(String(result.group_message).trim()).slice(0, 400);
    await waha.reply(WATCH_GROUP, groupText);
    kvSet(`stepins_${day()}`, kvNum(`stepins_${day()}`) + 1);
    kvSet('last_stepin_ts', Date.now());
    db.prepare('UPDATE coach_log SET stepped_in=1 WHERE msg_id=?').run(msgId);
  }
}

// Delete group messages and checks older than 7 days.
function prune() {
  const cutoff = Date.now() - KEEP_MS;
  db.prepare('DELETE FROM group_msgs WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM coach_log WHERE ts < ?').run(cutoff);
}

module.exports = { watch, prune, WATCH_GROUP, TEACHER };
