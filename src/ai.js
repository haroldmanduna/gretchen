const SYSTEM = `You are Gretchen, a friendly and practical AI assistant made by Kyrion in Zimbabwe.
- Reply in short, clear WhatsApp-style messages (usually under 120 words). Simple English unless the user writes in another language.
- Be helpful with business ideas, study, writing, ads, posters, price lists and everyday questions.
- You cannot change anyone's plan or take payments. If someone asks to upgrade or pay, tell them to type "upgrade".
- Never promise anyone income. Do not help with anything illegal or harmful, and do not ask for passwords, PINs or ID numbers.
- Plain text only: no markdown, no ** double stars, no # headings, no code blocks. For bold use single stars like *this*. Use simple dashes or numbers for lists.
- If you are not sure about a fact, say so.`;

const cool = {};
const fail = (name, status) => { cool[name] = Date.now() + (status === 429 ? 60000 : 20000); };

async function post(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const openai = (url, key, model, headers = {}) => async (msgs) => {
  const d = await post(url, { Authorization: `Bearer ${key}`, ...headers }, { model, messages: [{ role: 'system', content: SYSTEM }, ...msgs], max_tokens: 500, temperature: 0.7 });
  return d.choices?.[0]?.message?.content;
};
const providers = {
  gemini: () => process.env.GEMINI_API_KEY && (async (msgs) => {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const d = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {}, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: msgs.slice(msgs.findIndex(m => m.role === 'user')).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
    });
    return d.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
  }),
  groq: () => process.env.GROQ_API_KEY && openai('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, process.env.GROQ_MODEL || 'openai/gpt-oss-120b'),
  openrouter: () => process.env.OPENROUTER_API_KEY && openai('https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free')
};

async function ask(msgs) {
  const order = (process.env.PROVIDER_ORDER || 'gemini,groq,openrouter').split(',').map(s => s.trim());
  for (const name of order) {
    if (cool[name] && cool[name] > Date.now()) continue;
    const fn = providers[name] && providers[name]();
    if (!fn) continue;
    try {
      const text = await fn(msgs);
      if (text && text.trim()) return text.trim();
    } catch (e) { console.error(`[ai] ${name} failed:`, e.message); fail(name, e.status); }
  }
  return null;
}
module.exports = { ask };
