// CommonJS handler - the format Netlify has been running reliably for this site.
// Note: this format buffers the whole response, so a single request must finish
// inside Netlify's 26s synchronous limit. The client therefore splits plan
// generation into three smaller requests that run in parallel.
exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  // Diagnostic: open this URL in a browser to confirm the function is live.
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, version: '1-buffered' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: event.body
    });
    const data = await response.text();
    return { statusCode: response.status, headers: cors, body: data };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
