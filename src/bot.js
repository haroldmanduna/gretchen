const { db, getUser, setUser, usageToday, bumpUsage, addMessage, history, firstSeen } = require('./db');
const { ask } = require('./ai');
const waha = require('./waha');
const coach = require('./coach');
const pay = require('./payments');

const digits = s => String(s || '').split('@')[0].replace(/\D/g, '');
const limits = () => ({ free: +process.env.FREE_LIMIT || 10, premium: +process.env.PREMIUM_LIMIT || 150, cohort: +process.env.COHORT_LIMIT || 300 });
const activePlan = u => (u.plan !== 'free' && u.expires_at && u.expires_at < Date.now() ? 'free' : u.plan);
const busy = new Set();
// Paid plans are paused. Set PAYMENTS_ENABLED=true to turn them back on.
const PAYMENTS_ON = process.env.PAYMENTS_ENABLED === 'true';
const PAUSED = 'Paid plans are coming soon. For now you can use Gretchen on the Free plan. Type *status* to see your usage.';
const notify = (chatId, text) => waha.reply(chatId, text);

const GREETING = '*Gretchen by Kyrion* 👋\nYour AI assistant on WhatsApp. Ask me anything: business ideas, study help, ads, posters and more.\n\nType *upgrade* to see Premium and the Certified Cohort.';

function plansText() {
  const p = pay.plans(), l = limits();
  return `*Gretchen plans*\n\n*Free:* ${l.free} messages a day.\n*Premium* ($${p.premium.price}, ${p.premium.days} days): ${l.premium} messages a day and the AI Literacy Premium month.\n*Certified Cohort* ($${p.cohort.price}, ${p.cohort.days} days): ${l.cohort} messages a day and the certified cohort.\n\nReply *premium* or *cohort* to pay with EcoCash.`;
}
function statusText(u, id) {
  const plan = activePlan(u), l = limits()[plan];
  const until = plan !== 'free' ? `\nActive until ${pay.fmt(u.expires_at)}.` : '';
  return `Your plan: *${plan}*.${until}\nMessages today: ${usageToday(id)} of ${l}.`;
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
  if (isGroup) await coach.watch(p, from, sender, text).catch((e) => console.error('[coach]', e));

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

  const plan = activePlan(user), lim = limits()[plan];
  if (usageToday(sender) >= lim)
    return waha.reply(from, plan === 'free'
      ? `You have used your ${lim} free messages today. Type *upgrade* for more, or come back tomorrow.`
      : `You have reached today's limit of ${lim} messages. It resets tomorrow.`);

  if (busy.has(sender)) return;
  busy.add(sender);
  try {
    if (!isGroup && !user.greeted) { setUser(sender, { greeted: 1 }); await waha.reply(from, GREETING); }
    const key = `${from}|${sender}`;
    const answer = await ask([...history(key, 10), { role: 'user', content: text }]);
    if (!answer) return waha.reply(from, 'I am having trouble thinking right now. Please try again in a minute.');
    addMessage(key, 'user', text);
    addMessage(key, 'assistant', answer);
    bumpUsage(sender);
    await waha.reply(from, answer.slice(0, 3500));
  } finally { busy.delete(sender); }
}
module.exports = { handle, notify, isBotTagged };
