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

// The two Suggest buttons in step 2 that anyone may use without paying. They
// are named rather than inferred, so adding a third is a deliberate edit here
// and not something the browser can decide for itself.
//
// Be clear about what this does and does not prove. The prompt text still comes
// from the browser, so someone who reads the page source can send whatever
// prompt they like with free_mode set. What stops that being a free Anthropic
// proxy is the budget below, not the mode name: a small token cap, a short
// prompt cap, and a handful of calls per address per hour. Treat FREE_MAX_PER_
// HOUR as the real control and keep it low.
const FREE_MODES = ['targetCust', 'marketSize', 'startFigures'];
const FREE_WINDOW_MS = 60 * 60 * 1000;
const FREE_MAX_PER_HOUR = 4;
const FREE_MAX_TOKENS = 400;
const FREE_MAX_PROMPT_CHARS = 6000;
const freeHits = new Map();

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

function tooManyFreeRequests(ip) {
  const now = Date.now();
  const rec = freeHits.get(ip);
  if (!rec || now - rec.start > FREE_WINDOW_MS) {
    freeHits.set(ip, { start: now, count: 1 });
    if (freeHits.size > 5000) freeHits.clear();
    return false;
  }
  rec.count += 1;
  return rec.count > FREE_MAX_PER_HOUR;
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

  // The body is read before the access check now, because whether a request
  // needs paid access depends on what it is asking for.
  let incoming;
  try {
    incoming = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: { message: 'Malformed request.' } }) };
  }

  const ip = headers['x-nf-client-connection-ip'] || headers['client-ip'] ||
             (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  // Paid access, checked here rather than in the browser. The Origin check
  // above only proves the request came from our page - it says nothing about
  // whether the person behind it has paid, and the page is public.
  const auth = String(headers.authorization || headers.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const access = verifyToken(token);
  const freeMode = typeof incoming.free_mode === 'string' ? incoming.free_mode : '';
  const isFree = !access.ok && FREE_MODES.indexOf(freeMode) !== -1;

  if (!access.ok && !isFree) {
    return {
      statusCode: 402,
      headers: cors,
      body: JSON.stringify({ error: { message: 'Your access has expired or was not found.', reason: access.reason } })
    };
  }

  if (isFree && tooManyFreeRequests(ip)) {
    return {
      statusCode: 429,
      headers: cors,
      body: JSON.stringify({ error: { message: 'That is as many free suggestions as this connection gets for now. Unlock the AI for $29 to keep going, or try again later.' } })
    };
  }
  if (tooManyRequests(ip)) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ error: { message: 'Too many requests. Please wait a moment and try again.' } }) };
  }

  const messages = Array.isArray(incoming.messages) ? incoming.messages.slice(0, MAX_MESSAGES) : [];
  if (!messages.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: { message: 'No messages supplied.' } }) };
  }

  // A free request gets a smaller budget on both axes. The two free prompts run
  // to roughly 1,200 characters and ask for 300-400 tokens, so these caps leave
  // them ample room while making the endpoint a poor substitute for paying.
  const promptCap = isFree ? FREE_MAX_PROMPT_CHARS : MAX_PROMPT_CHARS;
  const tokenCap = isFree ? FREE_MAX_TOKENS : MAX_TOKENS_CAP;

  const totalChars = messages.reduce(function (n, m) {
    return n + (typeof m.content === 'string' ? m.content.length : 0);
  }, 0);
  if (totalChars > promptCap) {
    return { statusCode: 413, headers: cors, body: JSON.stringify({ error: { message: 'That request is too large.' } }) };
  }

  const requested = parseInt(incoming.max_tokens, 10);
  const maxTokens = Math.min(isNaN(requested) ? 1000 : Math.max(1, requested), tokenCap);

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
