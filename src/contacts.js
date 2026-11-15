// Remembers every private contact in Supabase (table contacts), so a number that has
// already talked to Gretchen is never greeted as a new contact again.
// The local SQLite file is not kept across deploys, so it cannot be the source of truth.

async function isNewContact(digits, user) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const d = String(digits || '').replace(/\D/g, '');
  // Fallback when Supabase is unavailable: use the local flag.
  const fallback = !(user && user.greeted);
  if (!url || !key || !d) return fallback;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const timeout = () => AbortSignal.timeout(5000);
  try {
    const look = await fetch(`${url}/rest/v1/contacts?phone=eq.${d}&select=phone`, { headers, signal: timeout() });
    if (!look.ok) {
      console.error('[contacts] Supabase HTTP', look.status);
      return fallback;
    }
    const existing = await look.json();
    if (existing.length) {
      // Returning contact: refresh last_seen (best effort).
      fetch(`${url}/rest/v1/contacts?phone=eq.${d}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
        signal: timeout(),
      }).catch(() => {});
      return false;
    }
    // Not in Supabase yet: save it. A returning number that the local flag says already talked is not new.
    const ins = await fetch(`${url}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ phone: d }),
      signal: timeout(),
    });
    if (!ins.ok) {
      console.error('[contacts] insert HTTP', ins.status);
      return fallback;
    }
    return !(user && user.greeted);
  } catch (e) {
    console.error('[contacts] lookup failed:', e.message);
    return fallback;
  }
}

module.exports = { isNewContact };
