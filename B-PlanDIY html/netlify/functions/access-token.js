// Signed access tokens.
//
// The gate used to live entirely in the browser: app.html checked a plain
// expiry timestamp in localStorage, and the AI endpoint only checked that the
// request came from b-plandiy.com. Both are trivial to bypass - anyone could
// set the timestamp by hand, or copy a fetch call out of the page - which left
// the Anthropic key funding whoever cared to look.
//
// A token is issued when someone pays or verifies their email, and carries the
// expiry inside it along with an HMAC signature. The signature can only be
// produced with ACCESS_TOKEN_SECRET, which never leaves Netlify, so a token
// cannot be forged or its expiry extended. Verifying is a hash comparison
// rather than a database lookup, so it adds no latency and does not touch
// Airtable's rate limit.

const crypto = require('crypto');

function secret() {
  return process.env.ACCESS_TOKEN_SECRET || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', secret()).update(payload).digest());
}

// token = <email-hash>.<expiry-ms>.<signature>
// The email is hashed rather than carried in the clear, so a token sitting in
// somebody's browser storage does not expose their address.
function issueToken(email, expiryMs) {
  if (!secret()) return '';
  const who = b64url(crypto.createHash('sha256').update(String(email || '').toLowerCase().trim()).digest()).slice(0, 16);
  const payload = who + '.' + String(Math.floor(expiryMs));
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (!secret()) return { ok: false, reason: 'not configured' };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const payload = parts[0] + '.' + parts[1];
  const expected = sign(payload);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  // Constant-time compare, so the signature cannot be guessed a byte at a time.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad signature' };
  }

  const expiry = parseInt(parts[1], 10);
  if (!expiry || Date.now() > expiry) return { ok: false, reason: 'expired' };
  return { ok: true, expiry: expiry };
}

module.exports = { issueToken, verifyToken };
