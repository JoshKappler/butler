const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// An in-memory Redis with just the commands the relay uses.
function fakeRedis() {
  const kv = new Map();
  const list = (k) => { if (!kv.has(k)) kv.set(k, []); return kv.get(k); };
  const run = ([c, k, ...a]) => {
    switch (c) {
      case 'GET': return kv.has(k) ? kv.get(k) : null;
      case 'SET': kv.set(k, a[0]); return 'OK';
      case 'DEL': kv.delete(k); return 1;
      case 'INCR': kv.set(k, (Number(kv.get(k)) || 0) + 1); return kv.get(k);
      case 'INCRBY': kv.set(k, (Number(kv.get(k)) || 0) + Number(a[0])); return kv.get(k);
      case 'EXPIRE': return 1;
      case 'RPUSH': list(k).push(...a); return list(k).length;
      case 'LPUSH': for (const v of a) list(k).unshift(v); return list(k).length;
      case 'LTRIM': { const l = list(k); const s = Number(a[0]), e = Number(a[1]); const from = s < 0 ? l.length + s : s; const to = e < 0 ? l.length + e : e; kv.set(k, l.slice(Math.max(0, from), to + 1)); return 'OK'; }
      case 'LRANGE': { const l = kv.get(k) || []; const e = Number(a[1]); return l.slice(Number(a[0]), e < 0 ? l.length + e + 1 : e + 1); }
      default: throw new Error(`fake redis: ${c}`);
    }
  };
  return { cmd: async (...args) => run(args), pipeline: async (cs) => cs.map(run), multi: async (cs) => cs.map(run), kv };
}

const redis = fakeRedis();
require.cache[require.resolve('../remote/lib/redis')] = { id: 'r', filename: 'r', loaded: true, exports: { redis } };
process.env.BUTLER_PASSCODE = 'correct horse battery';
process.env.BUTLER_SESSION_SECRET = 'x'.repeat(40);
process.env.BUTLER_PC_TOKEN = 'p'.repeat(40);

const api = (name) => require(path.join('..', 'remote', 'api', name));

function call(handler, { method = 'GET', body, headers = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(d) { resolve({ code: this.code, body: d, headers: this.headers }); },
      send(d) { resolve({ code: this.code, body: d, headers: this.headers }); },
    };
    handler({ method, body, headers, query }, res);
  });
}

const PC = { authorization: `Bearer ${'p'.repeat(40)}` };
let cookie = '';
const phone = () => ({ cookie, 'x-butler': '1', 'content-type': 'application/json' });

test('wrong passcode is refused, right one sets a secure session cookie', async () => {
  const bad = await call(api('login'), { method: 'POST', body: { passcode: 'nope' }, headers: { 'x-forwarded-for': '1.1.1.1' } });
  assert.equal(bad.code, 401);
  const ok = await call(api('login'), { method: 'POST', body: { passcode: 'correct horse battery' }, headers: { 'x-forwarded-for': '1.1.1.1' } });
  assert.equal(ok.code, 200);
  const set = ok.headers['set-cookie'];
  assert.match(set, /HttpOnly; Secure; SameSite=Strict/);
  cookie = set.split(';')[0];
});

test('guessing is locked out after ten tries', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call(api('login'), { method: 'POST', body: { passcode: 'x' }, headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(last.code, 429);
});

test('a forged or missing session gets nothing', async () => {
  assert.equal((await call(api('state'))).code, 401);
  const forged = await call(api('state'), { headers: { cookie: `butler_session=${Date.now() + 1e9}.AAAA` } });
  assert.equal(forged.code, 401);
});

test('phone commands reach the PC exactly once, and PC events reach the phone', async () => {
  const sent = await call(api('command'), { method: 'POST', headers: phone(), body: { kind: 'text', text: 'open steam' } });
  assert.equal(sent.code, 200);
  const first = await call(api('pc'), { method: 'POST', headers: PC, body: { state: { agents: [] }, events: [{ type: 'reply', text: 'Opened.' }] } });
  assert.deepEqual(first.body.commands.map((c) => [c.kind, c.text]), [['text', 'open steam']]);
  const second = await call(api('pc'), { method: 'POST', headers: PC, body: {} });
  assert.deepEqual(second.body.commands, []);
  const st = await call(api('state'), { headers: phone(), query: { after: 0 } });
  assert.equal(st.body.pcOnline, true);
  assert.deepEqual(st.body.state, { agents: [] });
  assert.equal(st.body.events.at(-1).text, 'Opened.');
  const later = await call(api('state'), { headers: phone(), query: { after: st.body.events.at(-1).id } });
  assert.equal(later.body.events.length, 0);
});

test('commands need the same-site header, a known kind, and the PC needs its token', async () => {
  assert.equal((await call(api('command'), { method: 'POST', headers: { cookie }, body: { kind: 'text', text: 'x' } })).code, 403);
  assert.equal((await call(api('command'), { method: 'POST', headers: phone(), body: { kind: 'rm-rf' } })).code, 400);
  assert.equal((await call(api('pc'), { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: {} })).code, 401);
});

test('screenshots round-trip as JPEG', async () => {
  await call(api('pc'), { method: 'POST', headers: PC, body: { screen: Buffer.from('jpegbytes').toString('base64') } });
  const r = await call(api('screen'), { headers: phone() });
  assert.equal(r.headers['content-type'], 'image/jpeg');
  assert.equal(String(r.body), 'jpegbytes');
});

// ── the PC side ──────────────────────────────────────────────────────────────
const { createRelay } = require('../src/relay');

function relayRig(commands) {
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, json: async () => ({ commands: commands.splice(0) }) };
  };
  const executed = [];
  const answered = [];
  const clicks = [];
  const relay = createRelay({
    config: { relay: { url: 'https://butler.example.vercel.app/', pollMs: 1000 }, dock: { quickActions: [] } },
    env: { BUTLER_PC_TOKEN: 't'.repeat(40) },
    fetchImpl,
    tools: { execute: async (name, args) => { executed.push([name, args]); return { ok: true }; } },
    schemas: () => [{ type: 'function', name: 'open', description: 'd', parameters: { type: 'object', properties: {} } }, { type: 'function', name: 'show', description: 'd', parameters: { type: 'object', properties: {} } }],
    pending: { answer: (id, a) => answered.push([id, a]) },
    lanes: { agent: async (lane, opts) => { await opts.tools[0].run({ target: 'steam' }); return `lane ${lane} used ${opts.tools.map((t) => t.name).join(',')}`; } },
    winhost: { call: async (op, args) => { if (op === 'screenshot') return { x: 0, y: 0, w: 1280, h: 720, scale: 0.5, b64: 'SHOT' }; if (op === 'click') clicks.push(args); return true; } },
    snapshot: async () => ({ agents: [], routines: [], pending: [] }),
  });
  return { relay, posts, executed, answered, clicks };
}

test('PC relay: runs phone text through the remote lane with desk-only tools removed', async () => {
  const { relay, posts, executed } = relayRig([{ id: 7, kind: 'text', text: 'open steam' }]);
  assert.equal(relay.enabled, true);
  await relay.tick();
  await new Promise((r) => setTimeout(r, 10));
  await relay.tick();
  assert.equal(posts[0].url, 'https://butler.example.vercel.app/api/pc');
  assert.equal(posts[0].auth, `Bearer ${'t'.repeat(40)}`);
  assert.ok(posts[0].body.state, 'first tick sends state');
  assert.deepEqual(executed[0], ['open', { target: 'steam' }]);
  const events = posts[1].body.events;
  assert.deepEqual(events.map((e) => e.type), ['working', 'result', 'reply']);
  assert.equal(events[2].text, 'lane remote used open');
  assert.equal(posts[1].body.state, undefined, 'unchanged state is not resent');
});

test('PC relay: answers, screenshots and tap-to-click map to the desktop', async () => {
  const { relay, posts, answered, clicks } = relayRig([{ id: 1, kind: 'answer', qid: 'q3', answer: 'yes' }, { id: 2, kind: 'screen' }]);
  await relay.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(answered, [['q3', 'yes']]);
  await relay.handle({ kind: 'click', fx: 0.5, fy: 0.25 });
  assert.deepEqual(clicks, [{ x: 1280, y: 360, button: 'left', count: 1 }]);
  await relay.tick();
  assert.equal(posts[1].body.screen, 'SHOT');
  assert.ok(posts[1].body.state.screen.at > 0);
});

test('PC relay stays off without a URL and a long token', () => {
  const r = createRelay({ config: { relay: { url: '' }, dock: {} }, env: { BUTLER_PC_TOKEN: 'short' } });
  assert.equal(r.enabled, false);
});

test('the phone page ships the same markdown renderer as the dock', () => {
  const fs = require('fs');
  assert.equal(fs.readFileSync(path.join(__dirname, '..', 'remote', 'public', 'md.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'renderer', 'md.js'), 'utf8'));
});

test('phone voice: audio goes to OpenAI transcription with a vocabulary hint', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  const realFetch = global.fetch;
  let sent;
  global.fetch = async (url, init) => { sent = { url, form: init.body }; return { ok: true, json: async () => ({ text: 'open steam' }) }; };
  try {
    const audio = Buffer.alloc(2000, 1);
    const r = await call(api('transcribe'), { method: 'POST', body: audio, headers: { ...phone(), 'x-audio-type': 'audio/mp4' } });
    assert.equal(r.code, 200);
    assert.equal(r.body.text, 'open steam');
    assert.equal(sent.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(sent.form.get('model'), 'gpt-4o-transcribe');
    assert.match(sent.form.get('prompt'), /herdr/);
    assert.equal(sent.form.get('file').name, 'speech.m4a');
    const noCookie = await call(api('transcribe'), { method: 'POST', body: audio, headers: { 'x-butler': '1' } });
    assert.equal(noCookie.code, 401);
  } finally { global.fetch = realFetch; }
});

test('PC relay: phone keys, right click and scroll reach the desktop', async () => {
  const { relay, clicks } = relayRig([]);
  await relay.handle({ kind: 'screen' });
  await relay.handle({ kind: 'click', fx: 0.5, fy: 0.5, button: 'right' });
  assert.deepEqual(clicks.at(-1), { x: 1280, y: 720, button: 'right', count: 1 });
  await relay.handle({ kind: 'click', fx: 0, fy: 0, double: true });
  assert.equal(clicks.at(-1).count, 2);
});
