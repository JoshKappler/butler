// Upstash Redis over its REST API (what Vercel's Redis integration provides).
// No client library: one fetch per call, a pipeline or a transaction per request.
const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function post(path, body) {
  if (!URL_() || !TOKEN()) throw new Error('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const res = await fetch(URL_() + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`redis: ${data.error || res.status}`);
  return data;
}

const redis = {
  cmd: async (...args) => (await post('', args)).result,
  // Several commands in one round trip. Returns their results in order.
  pipeline: async (cmds) => (await post('/pipeline', cmds)).map((r) => r.result),
  // Same, but atomic: nothing else runs between them.
  multi: async (cmds) => {
    const data = await post('/multi-exec', cmds);
    return (Array.isArray(data) ? data : data.result).map((r) => r.result);
  },
};

module.exports = { redis };
