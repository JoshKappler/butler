// GET -> the latest screenshot the PC sent, as a JPEG.
const { redis } = require('../lib/redis');
const { isPhone } = require('../lib/auth');
const K = require('../lib/keys');

module.exports = async (req, res) => {
  if (!isPhone(req)) return res.status(401).json({ error: 'sign in' });
  const b64 = await redis.cmd('GET', K.SCREEN);
  if (!b64) return res.status(404).json({ error: 'no screenshot yet' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(b64, 'base64'));
};
