// Turns WhatsApp's own chat history for one private chat into a short transcript.
// Messages with fromMe=true were sent from Kyrion's account: by Harold by hand, or by Gretchen.
const MAX_LINE = 400;
const MAX_LINES = 12;

function prepare(convo, text, msgId) {
  const list = (convo || []).filter(m => m && typeof m.body === 'string' && m.body.trim());
  // Drop the message that triggered this reply, so it is not repeated in the transcript.
  const idx = msgId ? list.findIndex(m => m.id === msgId) : -1;
  if (idx >= 0) list.splice(idx, 1);
  else if (list.length && !list[list.length - 1].fromMe && list[list.length - 1].body.trim() === String(text).trim()) list.pop();
  const recent = list.slice(-MAX_LINES);
  const kyrionSpoke = recent.some(m => m.fromMe);
  const transcript = recent.map(m => `${m.fromMe ? 'Kyrion' : 'Customer'}: ${m.body.trim().slice(0, MAX_LINE)}`).join('\n');
  return { kyrionSpoke, transcript };
}

module.exports = { prepare };
