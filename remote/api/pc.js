// The PC's one call, once a second: POST {state?, events?, screen?} and get
// back every command queued since the last call. Draining is atomic, so a
// command is delivered exactly once.
const { redis } = require('../lib/redis');
const { isPC } = require('../lib/auth');
const K = require('../lib/keys');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isPC(req)) return res.status(401).json({ error: 'bad token' });
  const b = req.body || {};
  const writes = [['SET', K.SEEN, String(Date.now())]];
  if (b.state) writes.push(['SET', K.STATE, JSON.stringify(b.state)]);
  if (b.screen) writes.push(['SET', K.SCREEN, String(b.screen), 'EX', 900]);
  if (Array.isArray(b.events) && b.events.length) {
    const first = await redis.cmd('INCRBY', K.seq, b.events.length);
    const ids = b.events.map((e, i) => first - b.events.length + 1 + i);
    writes.push(['LPUSH', K.EVENTS, ...b.events.map((e, i) => JSON.stringify({ ...e, id: ids[i], at: e.at || Date.now() }))]);
    writes.push(['LTRIM', K.EVENTS, 0, K.MAX_EVENTS - 1]);
  }
  await redis.pipeline(writes);
  const [cmds] = await redis.multi([['LRANGE', K.CMDS, 0, -1], ['DEL', K.CMDS]]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ commands: (cmds || []).map((c) => JSON.parse(c)) });
};
