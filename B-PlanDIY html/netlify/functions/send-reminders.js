// All three functions read the same Airtable table, named literally so they
// cannot drift apart. Previously this one alone used AIRTABLE_TABLE_ID while
// save-user and verify-user hardcoded 'Users' - if that variable ever pointed
// elsewhere, reminders would query a different table from the one signups are
// written to, and nothing would reveal it until a renewal silently never sent.
const TABLE = 'Users';

exports.handler = async (event) => {
  try {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const soonExpiry = now + sevenDays;

    // Get users from Airtable expiring within 7 days who haven't been reminded
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}?filterByFormula=AND(NOT({ReminderSent}),{ExpiryTimestamp}<${soonExpiry},{ExpiryTimestamp}>${now})`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`
      }
    });

    const data = await response.json();
    const records = data.records || [];

    for (const record of records) {
      const { Name, Email, ExpiryTimestamp } = record.fields;
      if (!Email) continue;

      const expiryDate = new Date(ExpiryTimestamp).toDateString();

      // Send renewal reminder email
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'B-PlanDIY <support@b-plandiy.com>',
          to: Email,
          subject: 'Your B-PlanDIY access expires in 7 days',
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
              <div style="background:#01236d;padding:28px 32px;border-radius:12px 12px 0 0;text-align:center;">
                <h1 style="color:#d0b16f;font-size:24px;margin:0;">Your access expires soon</h1>
              </div>
              <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                <p style="font-size:16px;">Hi ${Name},</p>
                <p style="font-size:15px;color:#374151;">Just a heads up - your B-PlanDIY access expires on <strong>${expiryDate}</strong>.</p>
                <p style="font-size:15px;color:#374151;">Renew now to keep access to your business plan, cashflow forecast, WhatsApp community and free seminars.</p>
                <div style="text-align:center;margin:28px 0;">
                  <a href="https://buy.stripe.com/7sY5kE6Jo1vP0s9cxcabK00" style="background:#d0b16f;color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">Renew for $29</a>
                </div>
                <p style="font-size:14px;color:#6b7280;">Any questions? Email us at <a href="mailto:support@b-plandiy.com" style="color:#01236d;">support@b-plandiy.com</a></p>
              </div>
            </div>
          `
        })
      });

      // Mark reminder as sent in Airtable
      await fetch(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}/${record.id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ fields: { ReminderSent: true } })
        }
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ sent: records.length })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
