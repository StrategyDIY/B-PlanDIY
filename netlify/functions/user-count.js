// Returns how many people have signed up, for the counter in the footer.
//
// The count comes from the same Airtable table save-user writes to, so it goes
// up on its own when someone pays - there is nothing to increment by hand.
//
// Three things this has to get right:
//   1. The Airtable token must never reach the browser, so the browser asks us.
//   2. Airtable has no "count" endpoint. Records come back in pages of 100, so
//      we follow the offset and ask for a single field to keep each page small.
//   3. A landing page can be hit far more often than the number changes, and
//      Airtable allows only 5 requests a second per base. The answer is cached.

const TABLE = 'Users';
const CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 50; // 5,000 users; a safety stop, not an expected limit

let cache = { at: 0, count: null };

const ALLOWED_HOSTS = ['b-plandiy.com', 'www.b-plandiy.com'];

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

function corsFor(headers) {
  const origin = headers.origin || headers.Origin;
  const h = hostOf(origin);
  const allowed = h && ALLOWED_HOSTS.indexOf(h) !== -1;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed ? origin : 'https://b-plandiy.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    // Let the CDN and the browser hold it too, so most visits never reach here.
    'Cache-Control': 'public, max-age=300'
  };
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  const cors = corsFor(headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (cache.count !== null && Date.now() - cache.at < CACHE_MS) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ count: cache.count, cached: true }) };
  }

  try {
    let count = 0;
    let offset = '';
    let pages = 0;

    do {
      // fields[]=Email keeps each record tiny; we only need to count them.
      const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}` +
        `?pageSize=100&fields%5B%5D=Email${offset ? '&offset=' + encodeURIComponent(offset) : ''}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
      });

      if (!res.ok) throw new Error('Airtable returned ' + res.status);

      const data = await res.json();
      count += (data.records || []).length;
      offset = data.offset || '';
      pages += 1;
    } while (offset && pages < MAX_PAGES);

    cache = { at: Date.now(), count: count };
    return { statusCode: 200, headers: cors, body: JSON.stringify({ count: count }) };
  } catch (err) {
    // Serve a stale count rather than nothing, if we have one.
    if (cache.count !== null) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ count: cache.count, stale: true }) };
    }
    // Otherwise say so plainly; the page hides the counter rather than showing 0.
    return { statusCode: 200, headers: cors, body: JSON.stringify({ count: null, error: err.message }) };
  }
};
