// POST {passcode} -> session cookie. Ten wrong guesses from one address lock
// it out for fifteen minutes.
const { redis } = require('../lib/redis');
const { mintSession, sessionCookie, safeEqual } = require('../lib/auth');
const K = require('../lib/keys');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const pass = process.env.BUTLER_PASSCODE;
  if (!pass || pass.length < 8) return res.status(500).json({ error: 'BUTLER_PASSCODE is not set' });
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const key = K.login(ip);
  const [tries] = await redis.pipeline([['INCR', key], ['EXPIRE', key, 900, 'NX']]);
  if (tries > 10) return res.status(429).json({ error: 'too many tries, wait 15 minutes' });
  if (!safeEqual((req.body || {}).passcode, pass)) return res.status(401).json({ error: 'wrong passcode' });
  await redis.cmd('DEL', key);
  res.setHeader('Set-Cookie', sessionCookie(mintSession()));
  res.status(200).json({ ok: true });
};
