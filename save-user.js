const { issueToken } = require('./access-token');

const TABLE = 'Users';

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let airtableFailed = false;
  let airtableFailure = null;
  let data = {};

  try {
    data = JSON.parse(event.body);
    const expiryTimestamp = Date.now() + (90 * 24 * 60 * 60 * 1000);
    const paymentDate = new Date().toISOString().slice(0, 10);
    const expiryDate = new Date(expiryTimestamp).toDateString();
    const paymentDateFormatted = new Date().toDateString();

    // Save to Airtable
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: {
            Name: data.name || '',
            Email: data.email || '',
            Phone: data.phone || '',
            PaymentDate: paymentDate,
            ExpiryTimestamp: expiryTimestamp,
            ReminderSent: false,
            Referral: data.referral || ''
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
              <p style="font-size:16px;">Hi ${data.name},</p>
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
              <p style="font-size:16px;">Hi ${data.name},</p>
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
              <p style="font-size:15px;color:#374151;"><strong>Name:</strong> ${data.name || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>Email:</strong> ${data.email || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>Phone:</strong> ${data.phone || '-'}</p>
              <p style="font-size:15px;color:#374151;"><strong>How they heard:</strong> ${data.referral || '-'}</p>
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
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        expiry: expiryTimestamp,
        token: issueToken(data.email, expiryTimestamp),
        saved: !airtableFailed,
        airtableStatus: airtableRes.status,
        airtableError: airtableData.error || null
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
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, saved: false, expiry: Date.now() + (90 * 24 * 60 * 60 * 1000),
        token: issueToken(data.email, Date.now() + (90 * 24 * 60 * 60 * 1000)), debugError: err.message })
    };
  }
};
