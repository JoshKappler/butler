// Two kinds of caller, two locks.
//   The PC:     Authorization: Bearer BUTLER_PC_TOKEN
//   The phone:  a session cookie, minted after the passcode, HMAC-signed with
//               BUTLER_SESSION_SECRET, HttpOnly, Secure, SameSite=Strict.
const crypto = require('crypto');

const COOKIE = 'butler_session';
const DAYS = 30;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function secret() {
  const s = process.env.BUTLER_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('BUTLER_SESSION_SECRET must be set (32+ characters)');
  return s;
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function mintSession(now = Date.now()) {
  const exp = String(now + DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
}

function sessionCookie(value) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}

function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : '';
}

function isPhone(req, now = Date.now()) {
  const [exp, mac] = readCookie(req).split('.');
  if (!exp || !mac || !safeEqual(mac, sign(exp))) return false;
  return Number(exp) > now;
}

function isPC(req) {
  const t = process.env.BUTLER_PC_TOKEN;
  if (!t || t.length < 32) return false;
  return safeEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), t);
}

// State-changing phone calls must be same-site JSON with this header, which a
// cross-site form cannot send. SameSite=Strict already blocks the cookie.
function sameSite(req) {
  return req.headers['x-butler'] === '1' && /application\/json/.test(req.headers['content-type'] || '');
}

module.exports = { mintSession, sessionCookie, isPhone, isPC, sameSite, safeEqual, COOKIE };
