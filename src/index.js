const express = require('express');
const bot = require('./bot');
const pay = require('./payments');

// Core settings: without these the app cannot receive or send WhatsApp messages.
const REQUIRED = ['WEBHOOK_KEY', 'WAHA_URL'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[config] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'].some((k) => process.env[k]))
  console.warn('[config] No AI provider key is set. Gretchen will not answer until one is added.');
if (!process.env.PAYNOW_ID || !process.env.PAYNOW_KEY || !process.env.PUBLIC_URL)
  console.warn('[config] Paynow is not fully set (PAYNOW_ID, PAYNOW_KEY, PUBLIC_URL). Payments are off.');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => res.send('Gretchen by Kyrion is running'));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// WAHA sends WhatsApp events here: set webhook to https://YOUR-APP/webhook?key=WEBHOOK_KEY
// Requests without the correct key are rejected, so nobody else can feed the bot.
app.post('/webhook', (req, res) => {
  if (req.query.key !== process.env.WEBHOOK_KEY) return res.sendStatus(401);
  res.sendStatus(200);
  const b = req.body || {};
  if (b.event === 'message' && b.payload) {
    bot.handle(b.payload).catch((e) => console.error('[bot]', e));
  }
});

// Paynow calls this. We never trust its body: we re-check with Paynow's poll URL.
app.post('/paynow/result', (_req, res) => {
  res.sendStatus(200);
  pay.checkPending(bot.notify).catch((e) => console.error('[pay]', e));
});

const tick = () => pay.checkPending(bot.notify).catch((e) => console.error('[pay]', e));
if (process.env.PAYMENTS_ENABLED === 'true') setInterval(tick, 15000);
const daily = () => pay.maintenance(bot.notify).catch((e) => console.error('[maint]', e));
setInterval(daily, 3600000);
setTimeout(daily, 10000);

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

app.listen(process.env.PORT || 3000, () => console.log('Gretchen by Kyrion is up'));
