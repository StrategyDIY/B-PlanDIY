// Netlify Functions v2 (ES module) format.
//
// The previous version used the older `exports.handler` style, which buffers the
// whole upstream response before returning anything. That meant a long plan had
// to finish generating inside Netlify's 26s synchronous limit, and anything
// longer returned a 504 "Inactivity Timeout".
//
// This version pipes Anthropic's response straight through to the browser. When
// the caller passes `stream: true`, tokens flow continuously, so the connection
// is never idle, the inactivity timeout never fires, and the plan can be as long
// as we like. Short requests (the AI Suggest buttons) still use the JSON path.

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }

  try {
    const bodyText = await req.text();
    let wantsStream = false;
    try { wantsStream = JSON.parse(bodyText).stream === true; } catch (e) {}

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: bodyText
    });

    // Streaming: hand the upstream body straight to the browser untouched.
    if (wantsStream && upstream.ok && upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: Object.assign({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        }, cors)
      });
    }

    // Non-streaming, or an upstream error we want to surface as JSON.
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message } }), {
      status: 500,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }
};
