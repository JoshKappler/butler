// GET ?after=<event id> -> the PC's latest snapshot, events newer than the
// cursor, and whether the PC is online. The phone polls this.
const { redis } = require('../lib/redis');
const { isPhone } = require('../lib/auth');
const K = require('../lib/keys');

module.exports = async (req, res) => {
  if (!isPhone(req)) return res.status(401).json({ error: 'sign in' });
  const after = Number(req.query.after || 0);
  const [state, events, seen] = await redis.pipeline([['GET', K.STATE], ['LRANGE', K.EVENTS, 0, 99], ['GET', K.SEEN]]);
  const fresh = (events || []).map((e) => JSON.parse(e)).filter((e) => e.id > after).reverse();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    state: state ? JSON.parse(state) : null,
    events: fresh,
    pcSeen: Number(seen || 0),
    pcOnline: Date.now() - Number(seen || 0) < 8000,
  });
};
