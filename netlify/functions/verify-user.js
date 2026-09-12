const { issueToken } = require('./access-token');

const TABLE = 'Users';

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store'
  };
}

// This endpoint answers "does this address have access", so an unthrottled
// version is a way to test addresses against the customer list one at a time.
// Six attempts a minute is ample for somebody typing their own address in and
// getting it wrong, and useless for working through a list.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 6;
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

exports.handler = async (event) => {
  const headers = event.headers || {};
  const cors = corsFor(headers);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ success: false, message: 'Method Not Allowed' }) };
  }

  const ip = headers['x-nf-client-connection-ip'] || headers['client-ip'] ||
             (headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooManyRequests(ip)) {
    return {
      statusCode: 429,
      headers: cors,
      body: JSON.stringify({ success: false, message: 'Too many attempts. Please wait a minute and try again.' })
    };
  }

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email || typeof email !== 'string' || email.indexOf('@') === -1) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, message: 'Please enter a valid email address.' }) };
    }

    // The address is escaped and the whole formula encoded before it goes near
    // the URL. Interpolating it raw meant an address containing & appended its
    // own query parameters - including a second filterByFormula, which could be
    // made to match somebody else's record - and one containing a quote broke
    // the formula outright, so a real customer was told they had no account.
    // Same construction as stripe-webhook.js.
    const clean = email.toLowerCase().trim();
    const formula = `LOWER({Email})='${clean.replace(/'/g, "\\'")}'`;
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}` +
      `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    // Airtable does not throw on 401 or 422. Without this an Airtable outage
    // read as "no subscription found" and sent a paying customer away.
    if (!response.ok) {
      return {
        statusCode: 503,
        headers: cors,
        body: JSON.stringify({ success: false, message: 'We could not check your access just now. Please try again in a moment, or email support@b-plandiy.com.' })
      };
    }

    const data = await response.json();
    const records = data.records || [];

    if (!records.length) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ success: false, message: 'No subscription found for this email address.' })
      };
    }

    const record = records[0].fields;
    const now = Date.now();
    const freeAccess = record.FreeAccess === true;
    const expiryTimestamp = record.ExpiryTimestamp || 0;

    // Grant access if FreeAccess is ticked OR expiry is in the future
    if (freeAccess || expiryTimestamp > now) {
      // Set expiry: free users get 10 years, paid users get their actual expiry
      const expiry = freeAccess ? now + (10 * 365 * 24 * 60 * 60 * 1000) : expiryTimestamp;
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ success: true, expiry: expiry, token: issueToken(email, expiry) })
      };
    }

    // Subscription expired
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: false,
        message: 'Your subscription has expired. Please purchase access to continue.'
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ success: false, message: 'Something went wrong. Please try again.' })
    };
  }
};
