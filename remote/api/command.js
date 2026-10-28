// POST a command for the PC. Kinds:
//   text   {text}             Butler handles it like a spoken request
//   tool   {name, args}       run one tool directly (tiles, agent keys)
//   answer {qid, answer}      answer something Butler is waiting on
//   screen {}                 take a screenshot
//   click  {fx, fy, button?, double?}  click a point on the last screenshot (0..1)
//   scroll {fx, fy, dy}       scroll there, positive is down
//   type   {text, enter?}     type into the focused app
//   keys   {keys}             a combo like "ctrl+c" or "alt+tab"
const { redis } = require('../lib/redis');
const { isPhone, sameSite } = require('../lib/auth');
const K = require('../lib/keys');

const KINDS = new Set(['text', 'tool', 'answer', 'screen', 'click', 'scroll', 'type', 'keys']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isPhone(req)) return res.status(401).json({ error: 'sign in' });
  if (!sameSite(req)) return res.status(403).json({ error: 'bad request origin' });
  const b = req.body || {};
  if (!KINDS.has(b.kind)) return res.status(400).json({ error: 'unknown kind' });
  const body = JSON.stringify(b);
  if (body.length > 20000) return res.status(413).json({ error: 'too long' });
  const id = await redis.cmd('INCR', K.seq);
  const cmd = { ...b, id, at: Date.now() };
  // A queue nobody drains should not grow forever if the PC is off for a week.
  await redis.pipeline([['RPUSH', K.CMDS, JSON.stringify(cmd)], ['LTRIM', K.CMDS, -100, -1], ['EXPIRE', K.CMDS, 86400]]);
  res.status(200).json({ id });
};
