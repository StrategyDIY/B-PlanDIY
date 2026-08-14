// Proxies requests to the Anthropic API so the key never reaches the browser.
//
// This endpoint is public by necessity - the app calls it from the client - so
// it has to defend itself. Four things it will not do:
//   1. Answer a request that did not come from b-plandiy.com
//   2. Let the caller choose the model
//   3. Let the caller ask for an unbounded number of tokens
//   4. Accept an oversized prompt, or a flood of requests from one address
//
// Netlify's synchronous limit is 26s, so a single request must finish inside
// that. The client splits plan generation into three smaller calls.

const { verifyToken } = require('./access-token');

const ALLOWED_HOSTS = [
  'b-plandiy.com',
  'www.b-plandiy.com'
];

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_CAP = 1500;
const MAX_PROMPT_CHARS = 24000;
const MAX_MESSAGES = 4;

// Best-effort throttle. Netlify may run several containers, so this is not a
// hard guarantee - it is enough to stop one client hammering the endpoint.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

function tooManyRequests(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_WINDOW;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

// A browser sends Origin on a POST; Referer is the fallback. If neither names
// our site, we do not serve the request.
function isAllowed(headers) {
  const origin = headers.origin || headers.Origin;
  const referer = headers.referer || headers.Referer;
  const host = hostOf(origin) || hostOf(referer);
  return !!host && ALLOWED_HOSTS.indexOf(host) !== -1;
}

function corsFor(headers) {
  const origin = headers.origin || headers.Origin;
  const h = hostOf(origin);
  const allowed = h && ALLOWED_HOSTS.indexOf(h) !== -1;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed ? origin : 'https://b-plandiy.com',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store'
  };
}

exports.handler = async (event) => {
  const headers = event.headers || {};
  const cors = corsFor(headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  if (!isAllowed(headers)) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: { message: 'Not permitted from this origin.' } }) };
  }

  // Paid access, checked here rather than in the browser. The Origin check
  // above only proves the request came from our page - it says nothing about
  // whether the person behind it has paid, and the page is public.
  const auth = String(headers.authorization || headers.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const access = verifyToken(token);
  if (!access.ok) {
    return {
      statusCode: 402,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Your access has expired or was not found.', reason: access.reason } })
    };
  }

  const ip = headers['x-nf-client-connection-ip'] || headers['client-ip'] ||
             (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooManyRequests(ip)) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ error: { message: 'Too many requests. Please wait a moment and try again.' } }) };
  }

  // Rebuild the request rather than forwarding what we were given, so the
  // caller cannot pick an expensive model or an unbounded token count.
  let incoming;
  try {
    incoming = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: { message: 'Malformed request.' } }) };
  }

  const messages = Array.isArray(incoming.messages) ? incoming.messages.slice(0, MAX_MESSAGES) : [];
  if (!messages.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: { message: 'No messages supplied.' } }) };
  }

  const totalChars = messages.reduce(function (n, m) {
    return n + (typeof m.content === 'string' ? m.content.length : 0);
  }, 0);
  if (totalChars > MAX_PROMPT_CHARS) {
    return { statusCode: 413, headers: cors, body: JSON.stringify({ error: { message: 'That request is too large.' } }) };
  }

  const requested = parseInt(incoming.max_tokens, 10);
  const maxTokens = Math.min(isNaN(requested) ? 1000 : Math.max(1, requested), MAX_TOKENS_CAP);

  const payload = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: messages.map(function (m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
    })
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.text();
    return { statusCode: response.status, headers: cors, body: data };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
