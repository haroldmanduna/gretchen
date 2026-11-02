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
// WhatsApp shows markdown as raw symbols, so turn it into WhatsApp formatting or plain text.
function toWhatsAppText(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = t.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1');     // code blocks -> plain text
  t = t.replace(/`([^`\n]+)`/g, '$1');                      // inline code -> plain text
  t = t.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, '*$1*'); // headings -> bold line
  t = t.replace(/^\s*[*\-+]\s+/gm, '• ');                   // bullet lines
  t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');                  // **bold** -> *bold*
  t = t.replace(/__(.+?)__/g, '*$1*');                      // __bold__ -> *bold*
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)'); // [text](url) -> text (url)
  t = t.replace(/\*\*/g, '');                               // any stray double stars
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
// Typing indicator plus a short human-like delay lowers the ban risk.
async function reply(chatId, rawText) {
  const text = toWhatsAppText(rawText);
  try { await call('/api/startTyping', { chatId }); } catch {}
  await sleep(700 + Math.random() * 1200 + Math.min(text.length * 12, 2500));
  try { await call('/api/stopTyping', { chatId }); } catch {}
  try { await call('/api/sendText', { chatId, text }); } catch (e) { console.error('[waha] send failed:', e.message); }
}
module.exports = { reply, toWhatsAppText };
