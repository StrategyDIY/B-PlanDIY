const { issueToken } = require('./access-token');


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

// Anything from the form is echoed into three HTML emails. Without escaping,
// a name field can carry markup or a link out of our own branded message.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Best-effort throttle, same shape as the one in anthropic.js.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;
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

// Asks Stripe whether this checkout session is real and was paid for.
//
// Until this existed the endpoint took a name and an email from anybody at all
// and answered with a signed access token - three months of paid access, and
// the Anthropic key sitting behind it, for the price of one POST. The browser
// cannot be trusted to assert a payment; only Stripe can confirm one.
//
// Fails closed. If the key is missing or Stripe cannot be reached, nobody is
// granted access - they are pointed at verify.html instead, which works from
// the record the signature-verified webhook already wrote.
async function verifiedSession(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { ok: false, reason: 'stripe key not configured' };
  if (!sessionId || !/^cs_[A-Za-z0-9_]{10,}$/.test(String(sessionId))) {
    return { ok: false, reason: 'no session id' };
  }
  try {
    const res = await fetch(
      'https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId),
      { headers: { 'Authorization': 'Bearer ' + key } }
    );
    if (!res.ok) return { ok: false, reason: 'stripe returned ' + res.status };
    const s = await res.json();
    if (s.payment_status !== 'paid') return { ok: false, reason: 'session not paid' };
    const d = s.customer_details || {};
    return {
      ok: true,
      id: s.id,
      email: d.email || s.customer_email || '',
      name: d.name || '',
      phone: d.phone || ''
    };
  } catch (e) {
    return { ok: false, reason: 'stripe unreachable' };
  }
}

// A paying customer is never blocked because our database is unavailable -
// Stripe has already taken their money. But a failure must not pass silently
// either, so it is flagged to support instead, loudly enough to act on.
async function alertSupport(subject, lines) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'B-PlanDIY <support@b-plandiy.com>',
        to: 'support@b-plandiy.com',
        subject: subject,
        html: '<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;">' +
          '<div style="background:#B14A38;padding:20px 24px;border-radius:12px 12px 0 0;">' +
          '<h1 style="color:#fff;font-size:19px;margin:0;">Action needed - customer record not saved</h1></div>' +
          '<div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">' +
          '<p style="font-size:15px;color:#374151;">This customer has <strong>paid and been granted access</strong>, but the Airtable write failed. ' +
          'Add them manually or they will be unable to restore access on another device, and will never receive a renewal reminder.</p>' +
          lines.map(function (l) { return '<p style="font-size:15px;color:#374151;margin:4px 0;">' + l + '</p>'; }).join('') +
          '</div></div>'
      })
    });
  } catch (e) {
    // Nothing further we can do from here.
  }
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
      body: JSON.stringify({ success: false, message: 'Too many requests. Please wait a moment and try again.' })
    };
  }

  let form = {};
  try {
    form = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, message: 'Malformed request.' }) };
  }

  // No token, no record and no email until Stripe confirms the payment.
  const paid = await verifiedSession(form.session_id);
  if (!paid.ok) {
    return {
      statusCode: 402,
      headers: cors,
      body: JSON.stringify({
        success: false,
        message: 'We could not confirm that payment. If you have already paid, you can restore your access at b-plandiy.com/verify.html, or email support@b-plandiy.com and we will sort it out.',
        reason: paid.reason
      })
    };
  }

  let airtableFailed = false;
  let airtableFailure = null;
  let data = {};

  try {
    // The address the customer typed on this page wins, and Stripe's is the
    // fallback.
    //
    // It used to be the other way round, to stop a mistyped address creating a
    // record nobody could verify against. But Apple Pay and Google Pay hand
    // Stripe a private relay address - fillet-helps7s@icloud.com and the like -
    // so for those customers the "safe" address was one they had never seen,
    // could not guess, and would never type at verify.html. The box on this
    // page is the only place a wallet customer states an address they
    // recognise, so that is the one their access is filed under.
    //
    // Validated rather than trusted: something that is not a plausible address
    // falls back to Stripe's rather than being written as the record key.
    const typedEmail = safeEmail(form.email);
    data = {
      email: typedEmail || paid.email || '',
      name: String(form.name || '').trim() || paid.name || '',
      phone: String(form.phone || '').trim() || paid.phone || '',
      referral: String(form.referral || '').trim()
    };
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const paymentDate = new Date().toISOString().slice(0, 10);
    const paymentDateFormatted = new Date().toDateString();

    // The Stripe webhook records most customers a few seconds before this form
    // is submitted. Without this lookup both of them write, and everyone who
    // completes the form lands in Airtable twice - two renewal reminders each,
    // and a homepage counter reading roughly double.
    // Both addresses have to be searched for, not just the one we are about to
    // store. The webhook has already written its row under Stripe's address; if
    // we only looked for the typed one we would never find that row, insert a
    // second, and reintroduce the duplicate this lookup exists to prevent.
    // Finding it means the PATCH below moves that row onto the typed address.
    const lookupEmails = [];
    [data.email, paid.email].forEach(function (e) {
      const safe = safeEmail(e);
      if (safe && lookupEmails.indexOf(safe) === -1) lookupEmails.push(safe);
    });
    let existing = null;
    for (let i = 0; i < lookupEmails.length && !existing; i++) {
      try {
        const lookup = await fetch(
          `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}` +
          `?filterByFormula=${encodeURIComponent(`LOWER({Email})='${lookupEmails[i]}'`)}&maxRecords=1`,
          { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` } }
        );
        const found = await lookup.json().catch(function () { return {}; });
        if (lookup.ok && found.records && found.records.length) existing = found.records[0];
      } catch (e) {
        // A failed lookup must never block a paying customer - fall through and insert.
      }
    }

    // Same rule as the webhook: a flat ninety days from today, not an extension
    // of what is left. See the note there - it keeps a repeat submission or a
    // retried webhook from compounding the expiry.
    const expiryTimestamp = Date.now() + NINETY_DAYS;
    const expiryDate = new Date(expiryTimestamp).toDateString();

    // Update the webhook's row where there is one, so the details only this
    // form collects - phone, how they heard of us - land on the same record
    // rather than on a second copy of the customer.
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}` +
        (existing ? '/' + existing.id : ''),
      {
        method: existing ? 'PATCH' : 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            Name: data.name || (existing && existing.fields.Name) || '',
            Email: data.email || '',
            Phone: data.phone || (existing && existing.fields.Phone) || '',
            PaymentDate: paymentDate,
            ExpiryTimestamp: expiryTimestamp,
            ReminderSent: false,
            Referral: data.referral || (existing && existing.fields.Referral) || ''
          }
        })
      }
    );

    // Airtable returning 401/422 does NOT throw, so checking .ok is the only
    // way to notice a rejected write. Without this the record silently never
    // existed: the customer kept browser access but could not restore it on
    // another device and never received a renewal reminder.
    const airtableData = await airtableRes.json().catch(function () { return {}; });
    if (!airtableRes.ok) {
      airtableFailed = true;
      airtableFailure = 'Airtable returned ' + airtableRes.status + ' - ' +
        ((airtableData.error && (airtableData.error.message || airtableData.error.type)) || 'no detail');
    }

    // Send receipt email to user
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'B-PlanDIY <support@b-plandiy.com>',
        to: data.email,
        subject: 'Your B-PlanDIY Receipt',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#01236d;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#d0b16f;font-size:24px;margin:0;">Payment Receipt</h1>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <p style="font-size:16px;">Hi ${esc(data.name)},</p>
              <p style="font-size:15px;color:#374151;">Thank you for your payment. Here is your receipt.</p>
              <div style="background:#f8f9fc;border-radius:8px;padding:20px;margin:20px 0;">
                <table style="width:100%;border-collapse:collapse;">
                  <tr><td style="font-size:14px;color:#6b7280;padding:6px 0;">Product</td><td style="font-size:14px;color:#374151;font-weight:600;text-align:right;">B-PlanDIY — 3 Month Access</td></tr>
                  <tr><td style="font-size:14px;color:#6b7280;padding:6px 0;">Amount</td><td style="font-size:14px;color:#374151;font-weight:600;text-align:right;">NZD $29.00</td></tr>
                  <tr><td style="font-size:14px;color:#6b7280;padding:6px 0;">Date</td><td style="font-size:14px;color:#374151;font-weight:600;text-align:right;">${paymentDateFormatted}</td></tr>
                  <tr><td style="font-size:14px;color:#6b7280;padding:6px 0;">Access expires</td><td style="font-size:14px;color:#374151;font-weight:600;text-align:right;">${expiryDate}</td></tr>
                </table>
              </div>
              <div style="text-align:center;margin:28px 0;">
                <a href="https://b-plandiy.com/app.html" style="background:#d0b16f;color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">Go to the app</a>
              </div>
              <p style="font-size:14px;color:#6b7280;">Any questions? Email us at <a href="mailto:support@b-plandiy.com" style="color:#01236d;">support@b-plandiy.com</a></p>
            </div>
          </div>
        `
      })
    });

    // Send welcome email to user
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'B-PlanDIY <support@b-plandiy.com>',
        to: data.email,
        subject: 'Welcome to B-PlanDIY!',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#01236d;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#d0b16f;font-size:24px;margin:0;">Welcome to B-PlanDIY!</h1>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <p style="font-size:16px;">Hi ${esc(data.name)},</p>
              <p style="font-size:15px;color:#374151;">Thanks for signing up to B-PlanDIY. Your 3-month access is now active.</p>
              <p style="font-size:15px;color:#374151;">Your access expires on <strong>${expiryDate}</strong>.</p>
              <div style="text-align:center;margin:28px 0;">
                <a href="https://b-plandiy.com/app.html" style="background:#d0b16f;color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">Go to the app</a>
              </div>
              <p style="font-size:14px;color:#6b7280;">You will also be added to our private WhatsApp community shortly, and invited to our free business planning seminars.</p>
              <p style="font-size:14px;color:#6b7280;">Any questions? Email us at <a href="mailto:support@b-plandiy.com" style="color:#01236d;">support@b-plandiy.com</a></p>
            </div>
          </div>
        `
      })
    });

    // Send notification email to admin
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'B-PlanDIY <support@b-plandiy.com>',
        to: 'support@b-plandiy.com',
        subject: 'New B-PlanDIY signup - ' + (data.name || 'Unknown'),
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#01236d;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#d0b16f;font-size:20px;margin:0;">New Signup!</h1>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
              <p style="font-size:15px;color:#374151;"><strong>Name:</strong> ${esc(data.name) || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>Email:</strong> ${esc(data.email) || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>Phone:</strong> ${esc(data.phone) || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>How they heard:</strong> ${esc(data.referral) || '-'}</p>
              <p style="font-size:13px;color:#6b7280;"><strong>Stripe session:</strong> ${esc(paid.id)}</p>
              <p style="font-size:15px;color:#374151;"><strong>Access expires:</strong> ${expiryDate}</p>
              <p style="font-size:13px;color:#6b7280;margin-top:16px;">Remember to add them to the WhatsApp group!</p>
              ${airtableFailed ? `<p style="font-size:15px;color:#B14A38;font-weight:700;margin-top:16px;">WARNING: this customer was NOT saved to Airtable. ${airtableFailure} - add them manually.</p>` : ''}
            </div>
          </div>
        `
      })
    });

    if (airtableFailed) {
      await alertSupport('ACTION NEEDED - Airtable save failed for ' + (data.email || 'unknown'), [
        '<strong>Name:</strong> ' + (data.name || '-'),
        '<strong>Email:</strong> ' + (data.email || '-'),
        '<strong>Phone:</strong> ' + (data.phone || '-'),
        '<strong>How they heard:</strong> ' + (data.referral || '-'),
        '<strong>Payment date:</strong> ' + paymentDateFormatted,
        '<strong>Access expires:</strong> ' + expiryDate,
        '<strong>Reason:</strong> ' + airtableFailure
      ]);
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: true,
        expiry: expiryTimestamp,
        token: issueToken(data.email, expiryTimestamp),
        saved: !airtableFailed,
        // Returned so the thank-you page can tell the customer which address
        // their access is filed under - it came from the payment, not from
        // anything they typed, so they have no other way to know it.
        email: data.email || ''
      })
    };
  } catch (err) {
    // Access is still granted - they have paid. But someone has to know, or
    // the signup is lost entirely: no record, and possibly no emails either.
    await alertSupport('ACTION NEEDED - signup failed for ' + (data.email || 'unknown'), [
      '<strong>Name:</strong> ' + (data.name || '-'),
      '<strong>Email:</strong> ' + (data.email || '-'),
      '<strong>Phone:</strong> ' + (data.phone || '-'),
      '<strong>How they heard:</strong> ' + (data.referral || '-'),
      '<strong>Error:</strong> ' + err.message,
      'Some of the customer emails may also have failed to send.'
    ]);
    // Stripe has confirmed the payment, so access is still granted - the
    // failure was ours, downstream of it. The expiry is recomputed here
    // because the block above may not have reached its own calculation.
    const fallbackExpiry = Date.now() + (90 * 24 * 60 * 60 * 1000);
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: true,
        saved: false,
        expiry: fallbackExpiry,
        token: issueToken(data.email, fallbackExpiry)
      })
    };
  }
};
