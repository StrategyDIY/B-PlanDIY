const { issueToken, issueLoginToken, verifyLoginToken, emailHash } = require('./access-token');

const SITE = 'https://b-plandiy.com';


// Airtable formula safety.
//
// Escaping only the single quote left a gap: a value ending in a backslash
// turns the escaped quote into a literal backslash followed by a real closing
// quote, and everything after it is parsed as formula rather than as data.
// An address is either a plausible email or it is not worth querying for, so
// this validates rather than sanitises.
function safeEmail(v){
  const e = String(v == null ? '' : v).trim().toLowerCase();
  if (e.length > 254) return '';
  if (/[\\'"`\r\n]/.test(e)) return '';
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) return '';
  return e;
}

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
    const body = JSON.parse(event.body || '{}');
    const email = body.email;
    const loginToken = typeof body.t === 'string' ? body.t : '';

    // Two ways in. Without a token this is a request for a magic link; with
    // one, it is that link being redeemed.
    let redeeming = false;
    let tokenWho = '';
    if (loginToken) {
      const lt = verifyLoginToken(loginToken);
      if (!lt.ok) {
        return {
          statusCode: 200,
          headers: cors,
          body: JSON.stringify({ success: false, message: lt.reason === 'expired'
            ? 'That link has expired. Enter your email below and we will send a fresh one.'
            : 'That link is not valid. Enter your email below and we will send a fresh one.' })
        };
      }
      redeeming = true;
      tokenWho = lt.who;
    }

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
    const safe = safeEmail(clean);
    if (redeeming && safe && emailHash(safe) !== tokenWho) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, message: 'That link does not match this email address.' }) };
    }
    if (!safe) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
    }
    const formula = `LOWER({Email})='${safe}'`;
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

    // Deliberately the same answer whether or not the address is on file.
    // Telling an anonymous caller "no subscription found" let anyone test
    // addresses and learn who your customers are.
    const SENT = {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ sent: true, message: 'If that address has access, we have emailed you a link to restore it. It expires in 20 minutes.' })
    };

    if (!records.length) return SENT;

    const recordId = records[0].id;
    const record = records[0].fields;
    const now = Date.now();
    const freeAccess = record.FreeAccess === true;
    const expiryTimestamp = record.ExpiryTimestamp || 0;

    // Grant access if FreeAccess is ticked OR expiry is in the future
    if (freeAccess || expiryTimestamp > now) {
      // A ticked FreeAccess used to grant ten years, which made a comped
      // account permanent in everything but name. It now grants the same
      // ninety days a paying customer gets.
      //
      // A later ExpiryTimestamp on the same row still wins, so a specific end
      // date can be set by hand where ninety days is not what is wanted.
      //
      // The tick is spent when it is used, not on every visit - see the
      // write-back below.
      const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
      const expiry = freeAccess ? Math.max(now + NINETY_DAYS, expiryTimestamp) : expiryTimestamp;

      // Redeeming a link: the token already proves they read the mailbox, so
      // access is granted here.
      if (redeeming) {
        // Spend the tick. Without this the expiry was recalculated from the
        // clock on every restore, so a comped account quietly renewed itself
        // for ninety more days each time it was used and never actually ran
        // out. Writing the granted expiry onto the row and clearing the tick
        // turns FreeAccess into "give this person ninety days, once": from
        // here the row is an ordinary one, it expires on the stored date, and
        // it collects a renewal reminder like everybody else.
        //
        // Only on redemption, never on a request for a link - otherwise a
        // stranger typing the address would burn the grant before its owner
        // ever clicked through.
        //
        // Best effort. If Airtable refuses, the customer still gets the
        // access they just proved they are entitled to; the tick simply
        // stays put and can be cleared by hand.
        if (freeAccess) {
          try {
            await fetch(
              `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}/${recordId}`,
              {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ fields: { ExpiryTimestamp: expiry, FreeAccess: false } })
              }
            );
          } catch (e) {
            // Deliberately swallowed - see above.
          }
        }
        return {
          statusCode: 200,
          headers: cors,
          body: JSON.stringify({ success: true, expiry: expiry, token: issueToken(email, expiry) })
        };
      }

      // Otherwise this is a request for a link. Access is NOT granted yet -
      // an email address is not a secret, and until today typing one was
      // enough to be handed ninety days of someone else's paid access.
      const link = `${SITE}/verify.html?t=${encodeURIComponent(issueLoginToken(safe))}&e=${encodeURIComponent(safe)}`;
      if (process.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'B-PlanDIY <support@b-plandiy.com>',
              to: [safe],
              subject: 'Your link back into B-PlanDIY',
              html: `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#29384A">
                <p>Here is your link to switch the AI features back on:</p>
                <p><a href="${link}" style="display:inline-block;background:#01236D;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:700">Restore my access</a></p>
                <p style="color:#5A6C7E;font-size:13.5px">The link works once and expires in 20 minutes. If you did not ask for it, you can ignore this email &mdash; nothing has changed on your account.</p>
              </div>`
            })
          });
        } catch (e) { /* the generic reply below is returned either way */ }
      }
      return SENT;
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
