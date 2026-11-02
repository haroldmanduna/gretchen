const base = () => (process.env.WAHA_URL || '').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, body) {
  const r = await fetch(base() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': process.env.WAHA_API_KEY || '' },
    body: JSON.stringify({ session: process.env.WAHA_SESSION || 'default', ...body }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`WAHA ${path} HTTP ${r.status}`);
}
// Typing indicator plus a short human-like delay lowers the ban risk.
async function reply(chatId, text) {
  try { await call('/api/startTyping', { chatId }); } catch {}
  await sleep(700 + Math.random() * 1200 + Math.min(text.length * 12, 2500));
  try { await call('/api/stopTyping', { chatId }); } catch {}
  try { await call('/api/sendText', { chatId, text }); } catch (e) { console.error('[waha] send failed:', e.message); }
}
module.exports = { reply };
