const { Paynow } = require('paynow');
const { db, getUser, setUser } = require('./db');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const plans = () => ({
  premium: { price: +env('PREMIUM_PRICE', 20), days: +env('PREMIUM_DAYS', 30), link: env('PREMIUM_LINK', '') },
  cohort: { price: +env('COHORT_PRICE', 60), days: +env('COHORT_DAYS', 60), link: env('COHORT_LINK', '') }
});
const paynow = () => {
  const p = new Paynow(process.env.PAYNOW_ID, process.env.PAYNOW_KEY);
  p.resultUrl = `${process.env.PUBLIC_URL}/paynow/result`;
  p.returnUrl = process.env.PUBLIC_URL;
  return p;
};
function toLocal(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('263')) d = '0' + d.slice(3);
  return /^07[7-8]\d{7}$/.test(d) ? d : null;
}
async function start(userId, chatId, plan, phone) {
  const cfg = plans()[plan];
  if (!cfg) return { ok: false, error: 'Unknown plan' };
  if (!process.env.PAYNOW_ID || !process.env.PAYNOW_KEY || !process.env.PUBLIC_URL)
    return { ok: false, error: 'payments are not set up yet' };
  const reference = `GRT-${plan.toUpperCase()}-${userId.slice(-6)}-${Date.now().toString(36)}`;
  try {
    const pn = paynow();
    const payment = pn.createPayment(reference, env('PAYNOW_AUTH_EMAIL', 'user@example.com'));
    payment.add(`Gretchen ${plan}`, cfg.price);
    const res = await pn.sendMobile(payment, phone, 'ecocash');
    if (!res.success) return { ok: false, error: res.error || 'Paynow rejected the request' };
    db.prepare('INSERT INTO payments(reference,user_id,chat_id,plan,amount,phone,poll_url,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(reference, userId, chatId, plan, cfg.price, phone, res.pollUrl, 'pending', Date.now());
    return { ok: true, price: cfg.price };
  } catch (e) {
    console.error('[pay] start failed:', e.message);
    return { ok: false, error: 'Payment service is unavailable' };
  }
}
function grant(userId, plan, days) {
  const u = getUser(userId);
  const base = u.plan === plan && u.expires_at && u.expires_at > Date.now() ? u.expires_at : Date.now();
  const expires = base + days * 86400000;
  setUser(userId, { plan, expires_at: expires, reminded: 0, state: null, pending_plan: null });
  return expires;
}
const fmt = ts => new Date(ts + 2 * 3600000).toISOString().slice(0, 10);

// Only a verified Paynow status can change a plan. The AI never can.
async function checkPending(notify) {
  const rows = db.prepare("SELECT * FROM payments WHERE status='pending'").all();
  for (const r of rows) {
    if (Date.now() - r.created_at > 30 * 60000) {
      db.prepare("UPDATE payments SET status='expired' WHERE reference=? AND status='pending'").run(r.reference);
      await notify(r.chat_id, 'Your EcoCash payment request timed out. Type *upgrade* to try again.');
      continue;
    }
    try {
      const s = await paynow().pollTransaction(r.poll_url);
      const st = String(s.status || '').toLowerCase();
      const paid = typeof s.paid === 'function' ? s.paid() : ['paid', 'awaiting delivery', 'delivered'].includes(st);
      if (paid) {
        if (s.amount !== undefined && Number(s.amount) + 0.001 < r.amount) {
          db.prepare("UPDATE payments SET status='underpaid' WHERE reference=?").run(r.reference);
          await notify(r.chat_id, 'Your payment was less than the plan price, so I could not upgrade you. Message Harold to sort it out.');
          continue;
        }
        const done = db.prepare("UPDATE payments SET status='paid', paid_at=? WHERE reference=? AND status='pending'").run(Date.now(), r.reference);
        if (done.changes !== 1) continue; // already processed, never credit twice
        const cfg = plans()[r.plan];
        const expires = grant(r.user_id, r.plan, cfg.days);
        const name = r.plan === 'cohort' ? 'the Certified Cohort' : 'Premium';
        await notify(r.chat_id, `Payment received. You are now on ${name} until ${fmt(expires)}. 🎉${cfg.link ? `\n\nYour access: ${cfg.link}` : ''}`);
      } else if (['cancelled', 'failed', 'disputed', 'refunded'].includes(st)) {
        db.prepare("UPDATE payments SET status='failed' WHERE reference=? AND status='pending'").run(r.reference);
        await notify(r.chat_id, 'The EcoCash payment did not go through. Type *upgrade* to try again.');
      }
    } catch (e) { console.error('[pay] poll failed:', e.message); }
  }
}
async function maintenance(notify) {
  const now = Date.now();
  for (const u of db.prepare("SELECT * FROM users WHERE plan!='free' AND expires_at IS NOT NULL AND expires_at<?").all(now)) {
    setUser(u.id, { plan: 'free', expires_at: null });
    if (u.chat_id) await notify(u.chat_id, 'Your plan has ended and you are back on Free. Type *upgrade* to renew.');
  }
  for (const u of db.prepare("SELECT * FROM users WHERE plan!='free' AND reminded=0 AND expires_at<?").all(now + 3 * 86400000)) {
    setUser(u.id, { reminded: 1 });
    if (u.chat_id) await notify(u.chat_id, `Your plan ends on ${fmt(u.expires_at)}. Type *upgrade* to renew.`);
  }
}
module.exports = { plans, toLocal, start, grant, checkPending, maintenance, fmt };
