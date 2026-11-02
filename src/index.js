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

// Pairing page for linking the WhatsApp number. Every route needs the WEBHOOK_KEY in the URL.
const path = require('path');
const pairKeyOk = (req) => !!process.env.WEBHOOK_KEY && req.query.key === process.env.WEBHOOK_KEY;
const wahaSession = () => process.env.WAHA_SESSION || 'default';
const wahaUrl = (p) => `${(process.env.WAHA_URL || '').replace(/\/$/, '')}${p}`;
const wahaHeaders = () => ({ 'X-Api-Key': process.env.WAHA_API_KEY || '', 'Content-Type': 'application/json' });

app.get('/pair', (req, res) => {
  if (!pairKeyOk(req)) return res.sendStatus(401);
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'pair.html'));
});

app.get('/pair/qr', async (req, res) => {
  if (!pairKeyOk(req)) return res.sendStatus(401);
  try {
    const r = await fetch(wahaUrl(`/api/${wahaSession()}/auth/qr?format=image`), { headers: wahaHeaders() });
    if (!r.ok) return res.status(502).send('QR not ready');
    res.set('Cache-Control', 'no-store');
    res.type(r.headers.get('content-type') || 'image/png');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).send('WAHA unreachable');
  }
});

app.get('/pair/status', async (req, res) => {
  if (!pairKeyOk(req)) return res.sendStatus(401);
  try {
    const r = await fetch(wahaUrl(`/api/sessions/${wahaSession()}`), { headers: wahaHeaders() });
    const d = await r.json().catch(() => ({}));
    res.set('Cache-Control', 'no-store');
    res.json({ status: d.status || null });
  } catch (e) {
    res.status(502).json({ status: null });
  }
});

// One code at a time. Requesting a new code resets the WhatsApp link, so we reuse the last code for 2 minutes
// and only ask WhatsApp for a code while the session is actually waiting for a scan.
let lastPairCode = { code: null, at: 0 };
app.get('/pair/code', async (req, res) => {
  if (!pairKeyOk(req)) return res.sendStatus(401);
  res.set('Cache-Control', 'no-store');
  if (lastPairCode.code && Date.now() - lastPairCode.at < 120000) return res.json({ code: lastPairCode.code, reused: true });
  const phone = (process.env.BOT_NUMBER || '').replace(/\D/g, '');
  if (!phone) return res.status(500).json({ code: null, message: 'BOT_NUMBER is not set' });
  try {
    const st = await fetch(wahaUrl(`/api/sessions/${wahaSession()}`), { headers: wahaHeaders() });
    const sd = await st.json().catch(() => ({}));
    if (sd.status !== 'SCAN_QR_CODE') return res.json({ code: null, status: sd.status || null, message: 'Session is not waiting for a link' });
    const r = await fetch(wahaUrl(`/api/${wahaSession()}/auth/request-code`), {
      method: 'POST', headers: wahaHeaders(), body: JSON.stringify({ phoneNumber: phone }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.code) lastPairCode = { code: d.code, at: Date.now() };
    res.json({ code: d.code || null, reused: false });
  } catch (e) {
    res.status(502).json({ code: null });
  }
});

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
