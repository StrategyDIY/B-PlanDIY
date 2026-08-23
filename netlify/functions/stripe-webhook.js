const crypto = require('crypto');

// Records a customer the moment Stripe confirms payment, rather than waiting
// for them to fill in the form on thankyou.html.
//
// The form was the only thing that created a record, so anyone who paid and
// then closed the tab - which is a reasonable thing to do once you have paid -
// left no trace. No Airtable row, no receipt, no way to restore access on
// another device, and no renewal reminder ninety days later. It happened to a
// real customer on 19 August.
//
// This runs on Stripe's checkout.session.completed event, so it fires whether
// or not the customer ever reaches the thank-you page.

const TABLE = 'Users';

function verifyStripeSignature(rawBody, header, secret) {
  // Stripe signs the payload; without checking it, anyone who found this URL
  // could grant themselves access by posting a fake event.
  if (!header || !secret) return false;
  const parts = {};
  header.split(',').forEach(function (p) {
    const [k, v] = p.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1') parts.v1 = (parts.v1 || []).concat(v);
  });
  if (!parts.t || !parts.v1) return false;

  // Reject anything older than five minutes, so a captured request cannot be
  // replayed later.
  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(parts.t, 10));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(parts.t + '.' + rawBody, 'utf8')
    .digest('hex');

  return parts.v1.some(function (sig) {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

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
          '<h1 style="color:#fff;font-size:19px;margin:0;">Action needed - paid customer not recorded</h1></div>' +
          '<div style="background:#fff;padding:24px;border:1px solid #E3E8F0;border-top:none;border-radius:0 0 12px 12px;">' +
          '<p style="font-size:15px;color:#29384A;">Stripe confirmed a payment but the Airtable write failed. ' +
          'Add this person manually or they will be unable to restore access and will never get a renewal reminder.</p>' +
          lines.map(function (l) { return '<p style="font-size:15px;color:#29384A;margin:4px 0;">' + l + '</p>'; }).join('') +
          '</div></div>'
      })
    });
  } catch (e) { /* nothing further we can do */ }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verifyStripeSignature(raw, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(raw); } catch (e) {
    return { statusCode: 400, body: 'Bad payload' };
  }

  // Only completed checkouts create a customer.
  if (evt.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ ignored: evt.type }) };
  }

  const session = (evt.data && evt.data.object) || {};
  if (session.payment_status !== 'paid') {
    return { statusCode: 200, body: JSON.stringify({ ignored: 'not paid' }) };
  }

  const email = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  const name = (session.customer_details && session.customer_details.name) || '';
  const phone = (session.customer_details && session.customer_details.phone) || '';

  if (!email) {
    await alertSupport('Paid customer with no email address', [
      'Session: ' + (session.id || 'unknown'),
      'Stripe did not provide an email, so no record could be created.'
    ]);
    return { statusCode: 200, body: JSON.stringify({ error: 'no email' }) };
  }

  const expiryTimestamp = Date.now() + (90 * 24 * 60 * 60 * 1000);
  const paymentDate = new Date().toISOString().slice(0, 10);

  try {
    // The thank-you form may also write a record. Look first so a customer who
    // does complete the form does not end up in Airtable twice.
    const lookup = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}` +
      `?filterByFormula=${encodeURIComponent(`LOWER({Email})='${email.toLowerCase().replace(/'/g, "\\'")}'`)}&maxRecords=1`,
      { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` } }
    );
    const existing = await lookup.json().catch(function () { return {}; });
    if (lookup.ok && existing.records && existing.records.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyRecorded: true }) };
    }

    const res = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            Name: name,
            Email: email,
            Phone: phone,
            PaymentDate: paymentDate,
            ExpiryTimestamp: expiryTimestamp,
            ReminderSent: false,
            Referral: 'stripe-webhook'
          }
        })
      }
    );

    // Airtable does not throw on 401 or 422, so the status has to be checked.
    if (!res.ok) {
      const detail = await res.json().catch(function () { return {}; });
      await alertSupport('Airtable write failed for a paid customer', [
        '<strong>Email:</strong> ' + email,
        '<strong>Name:</strong> ' + (name || 'not provided'),
        '<strong>Paid:</strong> ' + paymentDate,
        '<strong>Expiry timestamp:</strong> ' + expiryTimestamp,
        '<strong>Airtable said:</strong> ' + res.status + ' ' +
          ((detail.error && (detail.error.message || detail.error.type)) || 'no detail')
      ]);
      // Still 200: a non-2xx makes Stripe retry, and a retry will fail the
      // same way. Support has been told, which is the useful outcome.
      return { statusCode: 200, body: JSON.stringify({ ok: false, airtable: res.status }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, recorded: email }) };
  } catch (err) {
    await alertSupport('Webhook error for a paid customer', [
      '<strong>Email:</strong> ' + email,
      '<strong>Error:</strong> ' + err.message
    ]);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
