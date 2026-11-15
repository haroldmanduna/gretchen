const { db, getUser, setUser, usageToday, bumpUsage, addMessage, history, firstSeen } = require('./db');
const { ask } = require('./ai');
const prompt = require('./prompt');
const pitches = require('./pitch');
const contacts = require('./contacts');
const waha = require('./waha');
const coach = require('./coach');
const { prepare: convoPrepare } = require('./convo');
const pay = require('./payments');

const digits = s => String(s || '').split('@')[0].replace(/\D/g, '');
const activePlan = u => (u.plan !== 'free' && u.expires_at && u.expires_at < Date.now() ? 'free' : u.plan);
const busy = new Set();
// Paid plans are paused. Set PAYMENTS_ENABLED=true to turn them back on.
const PAYMENTS_ON = process.env.PAYMENTS_ENABLED === 'true';
const PAUSED = 'Paid plans are coming soon. For now you can use Gretchen on the Free plan. Type *status* to see your usage.';
const notify = (chatId, text) => waha.reply(chatId, text);

// Extra instructions for a first message. One combined reply, no separate greeting message.
const NEW_CONTACT_NOTE = `

THIS MESSAGE
This is the first message from this person, and they contacted us first. Reply in ONE message: open with a short line like "Hi, I'm Gretchen from Kyrion 👋 We build websites and AI assistants for businesses.", respond to anything they said, then ask one question: what kind of business do they run? Skip that question if they already told you. Keep it to 2-3 sentences.`;
const PITCHED_NOTE = `

THIS MESSAGE
We messaged this business first, so this is a reply to our pitch. Do not introduce yourself again and do not ask what kind of business they run or what they need. If they ask who this is, answer in one short sentence (you are Kyrion's assistant and Harold reached out), then carry on from the pitch. Do not say your name and do not start with "I am". Start with your answer to what they said. The business name is already known, so the next missing detail is the town, then their name, then the best time to talk. Ask only one of these. Continue from the pitch above and respond to what they said in 2-3 sentences.`;


// Kyrion already talked with this chat (by hand or by Gretchen): carry on from the last message, no intro.
const KYRION_FIRST_NOTE = `

THIS MESSAGE
Kyrion has already been talking with this person (see EARLIER CONVERSATION). Do not introduce yourself, do not say your name, and do not greet them as new. Start with your answer to what they said. Read what Kyrion already asked and what the person already answered. Never ask those again, and do not ask for the business type unless it is missing from that conversation. Reply to what they just said, then continue from the last thing Kyrion asked, with at most one question. Keep it to 2-3 sentences.`;

function plansText() {
  const p = pay.plans();
  return `*Gretchen plans*\n\n*Free:* unlimited messages.\n*Premium* ($${p.premium.price}, ${p.premium.days} days): unlimited messages.\n*Certified Cohort* ($${p.cohort.price}, ${p.cohort.days} days): unlimited messages.\n\nReply *premium* or *cohort* to pay with EcoCash.`;
}
function statusText(u, id) {
  const plan = activePlan(u);
  const until = plan !== 'free' ? `\nActive until ${pay.fmt(u.expires_at)}.` : '';
  return `Your plan: *${plan}*.${until}\nMessages today: ${usageToday(id)}. Messages are unlimited.`;
}

async function admin(from, text) {
  const [, cmd, who, plan, days] = text.split(/\s+/);
  if (cmd === 'grant' && who && ['premium', 'cohort'].includes(plan)) {
    const exp = pay.grant(digits(who), plan, +days || 30);
    return waha.reply(from, `Granted ${plan} to ${digits(who)} until ${pay.fmt(exp)}.`);
  }
  if (cmd === 'stats') {
    const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const paid = db.prepare("SELECT COUNT(*) c FROM users WHERE plan!='free'").get().c;
    const rev = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='paid'").get().s;
    return waha.reply(from, `Users: ${n}\nPaid plans: ${paid}\nRevenue: $${rev}`);
  }
  return waha.reply(from, 'Admin: /admin grant <number> <premium|cohort> <days> | /admin stats');
}

// True when WhatsApp reports that the bot's own number was tagged in this message.
async function isBotTagged(p) {
  const mine = await waha.myIds();
  if (!mine.length) return false;
  const ids = [].concat(p.mentionedIds || [], p._data?.mentionedJidList || [], p._data?.mentionedJid || []);
  if (ids.some(id => mine.includes(digits(typeof id === 'string' ? id : (id?._serialized || id?.user || ''))))) return true;
  // Some clients keep the tag as plain text such as "@263716987183" or "@<LID digits>".
  const body = String(p.body || '');
  return mine.some(m => new RegExp(`@${m}(?!\\d)`).test(body));
}

async function handle(p) {
  if (!p || p.fromMe) return;
  const from = p.from || '';
  if (!from || from === 'status@broadcast' || from.endsWith('@newsletter') || from.endsWith('@broadcast')) return;
  if (p.id && !firstSeen(p.id)) return;
  const isGroup = from.endsWith('@g.us');
  const sender = digits(isGroup ? p.participant || p._data?.author : from);
  let text = String(p.body || '').trim().slice(0, 1500);
  if (!sender || !text) return;

  // Watched group: keep a short log of everything and check the teacher's answers (no replies here).
  // AI Literacy coaching is switched off for the business assistant. Set COACH_ENABLED=true to bring it back.
  if (isGroup && process.env.COACH_ENABLED === 'true') await coach.watch(p, from, sender, text).catch((e) => console.error('[coach]', e));

  // Group: only answer when someone actually tags the bot (WhatsApp @mention), not when its name is typed.
  if (isGroup) {
    if (!(await isBotTagged(p))) return;
    text = text.replace(/@\d[\d\s]*/g, ' ').replace(/@gretchen\b/gi, ' ').replace(/\s+/g, ' ').trim() || 'Hello';
    if (/\b(upgrade|subscribe|pricing|premium|cohort)\b/i.test(text))
      return PAYMENTS_ON ? waha.reply(from, `To upgrade, message me privately: https://wa.me/${process.env.BOT_NUMBER || ''}`) : null;
  }

  const user = getUser(sender);
  if (!isGroup && user.chat_id !== from) setUser(sender, { chat_id: from });

  if (!isGroup) {
    if (sender === digits(process.env.ADMIN_PHONE) && text.startsWith('/admin')) return admin(from, text);
    const lower = text.toLowerCase();
    if (user.state === 'awaiting_number') {
      if (['cancel', 'stop', 'no'].includes(lower)) {
        setUser(sender, { state: null, pending_plan: null });
        return waha.reply(from, 'No problem, cancelled.');
      }
      const phone = pay.toLocal(text);
      if (!phone) return waha.reply(from, 'Send your EcoCash number like 0777123456, or type *cancel*.');
      setUser(sender, { state: null });
      const r = await pay.start(sender, from, user.pending_plan, phone);
      return waha.reply(from, r.ok
        ? `I have sent a $${r.price} EcoCash prompt to ${phone}. Enter your PIN on your phone. I will confirm here as soon as it goes through.`
        : `I could not start the payment: ${r.error}. Type *upgrade* to try again.`);
    }
    if (!PAYMENTS_ON && /^(upgrade|plans?|subscribe|pricing|premium|cohort|buy premium|buy cohort|pay premium|pay cohort|get premium|get cohort|check payment)$/.test(lower))
      return waha.reply(from, PAUSED);
    if (/^(upgrade|plans?|subscribe|pricing)$/.test(lower)) return waha.reply(from, plansText());
    const m = lower.match(/^(?:buy |pay |get )?(premium|cohort)$/);
    if (m) {
      setUser(sender, { state: 'awaiting_number', pending_plan: m[1] });
      return waha.reply(from, `Good choice: ${m[1]} ($${pay.plans()[m[1]].price}). Send the EcoCash number to charge, like 0777123456. Type *cancel* to stop.`);
    }
    if (lower === 'status') return waha.reply(from, statusText(user, sender));
    if (lower === 'check payment') { await pay.checkPending(notify); return waha.reply(from, 'Checked. I will message you when a payment goes through.'); }
  }

  // No daily message cap: messages are unlimited on every plan.

  if (busy.has(sender)) return;
  busy.add(sender);
  try {
    const key = `${from}|${sender}`;
    // Read this chat from WhatsApp itself, so messages Kyrion sent by hand (for example by Harold) are seen too.
    const convo = isGroup ? { kyrionSpoke: false, transcript: '' } : convoPrepare(await waha.recentMessages(from).catch(e => { console.error('[waha] chat history:', e.message); return []; }), text, p.id);
    // First contact is decided by the Supabase contacts table, so returning numbers are never greeted as new.
    const isNew = !isGroup && (await contacts.isNewContact(sender, user));
    if (isNew) setUser(sender, { greeted: 1 });
    // If Kyrion has already written to this chat (by hand or by Gretchen), never introduce again.
    const first = isNew && !convo.kyrionSpoke;
    // Businesses we messaged first get a pitch record; they continue from the pitch, not a fresh intro.
    const pitch = isGroup ? null : await pitches.forPhone(sender);
    let note = '';
    if (pitch && (first || convo.kyrionSpoke)) note = PITCHED_NOTE;
    else if (convo.kyrionSpoke) note = KYRION_FIRST_NOTE;
    else if (first) note = NEW_CONTACT_NOTE;
    const earlier = convo.transcript
      ? `\n\nEARLIER CONVERSATION IN THIS CHAT (oldest first). Lines starting with "Kyrion:" were sent by Kyrion, either by Harold by hand or by Gretchen. Read them and continue from exactly where they left off.\n${convo.transcript}`
      : '';
    const sys = (await prompt.getFilled(pitch)) + earlier + note;
    const msgs = convo.transcript ? [{ role: 'user', content: text }] : [...history(key, 10), { role: 'user', content: text }];
    const answer = await ask(msgs, sys);
    if (!answer) return waha.reply(from, 'I am having trouble thinking right now. Please try again in a minute.');
    addMessage(key, 'user', text);
    addMessage(key, 'assistant', answer);
    bumpUsage(sender);
    let reply = answer.slice(0, 3500);
    // Usage hint is for numbers that already subscribed, and only on their first message in a session.
    if (first && activePlan(user) !== 'free') reply += '\n\nType *status* to see your usage.';
    await waha.reply(from, reply);
  } finally { busy.delete(sender); }
}
module.exports = { handle, notify, isBotTagged };
