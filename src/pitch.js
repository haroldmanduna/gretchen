// Outbound pitches: businesses Harold messaged first. Harold adds a row to the
// outbound_pitches table in Supabase (phone as digits, e.g. 263771234567).
// Gretchen looks the row up by the sender's phone number.

const cache = new Map(); // digits -> { row, at }
const TTL_MS = 60000;

async function forPhone(digits) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const d = String(digits || '').replace(/\D/g, '');
  if (!url || !key || !d) return null;
  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  try {
    const r = await fetch(
      `${url}/rest/v1/outbound_pitches?phone=eq.${d}&active=eq.true&select=business_name,service_pitched,first_message_sent,sample_link`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) {
      console.error('[pitch] Supabase HTTP', r.status);
      return null;
    }
    const rows = await r.json();
    const row = rows[0] || null;
    cache.set(d, { row, at: Date.now() });
    return row;
  } catch (e) {
    console.error('[pitch] lookup failed:', e.message);
    return null;
  }
}

module.exports = { forPhone };
