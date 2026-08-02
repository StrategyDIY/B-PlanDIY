// Netlify Functions v2 (ES module).
//
// NOTE ON THE .mjs EXTENSION - this matters.
// A .js file using `export default` is only parsed as an ES module when the
// package.json declares "type": "module". This project's other functions
// (save-user, verify-user, send-reminders) are CommonJS, so setting that flag
// would break them. The .mjs extension forces ESM for this file alone.
//
// WHY STREAMING.
// The previous version used the older `exports.handler` style, which buffers the
// entire upstream response before returning anything. A long plan therefore had
// to finish generating inside Netlify's 26s synchronous limit, and anything
// longer returned a 504 "Inactivity Timeout".
//
// This version pipes Anthropic's response straight through to the browser. When
// the caller passes `stream: true`, tokens flow continuously, the connection is
// never idle, and plan length is no longer bounded by the function timeout.

const VERSION = '2-streaming';

export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Diagnostic: open the function URL in a browser to confirm which version is
  // live. Anything other than the JSON below means the old function is still
  // deployed, or this file was not picked up.
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, version: VERSION, streaming: true }), {
      status: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
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
          'X-Accel-Buffering': 'no',
          'X-Bpd-Version': VERSION
        }, cors)
      });
    }

    // Non-streaming (AI Suggest buttons), or an upstream error to surface.
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Bpd-Version': VERSION }, cors)
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message } }), {
      status: 500,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors)
    });
  }
};
