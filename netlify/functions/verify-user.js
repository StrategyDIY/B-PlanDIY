const TABLE = 'Users';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email } = JSON.parse(event.body);
    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Email required' }) };
    }

    // Search Airtable for this email
    const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${TABLE}?filterByFormula=LOWER({Email})="${email.toLowerCase().trim()}"`;

    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
    });

    const data = await response.json();
    const records = data.records || [];

    if (!records.length) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
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
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ success: true, expiry: expiry })
      };
    }

    // Subscription expired
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: false,
        message: 'Your subscription has expired. Please purchase access to continue.'
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: 'Something went wrong. Please try again.' })
    };
  }
};
