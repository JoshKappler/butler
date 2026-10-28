const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const { createCaptions, pickEngine, createTranscript } = require('../src/voice/captions');

test('auto prefers Muse when a Meta key is set', () => {
  const cfg = { captions: { engine: 'auto' } };
  assert.equal(pickEngine(cfg, { META_API_KEY: 'x', OPENAI_API_KEY: 'y' }), 'muse');
  assert.equal(pickEngine(cfg, { OPENAI_API_KEY: 'y' }), 'openai');
  assert.equal(pickEngine(cfg, {}), 'off');
  assert.equal(pickEngine({ captions: { engine: 'openai' } }, { META_API_KEY: 'x' }), 'openai');
});

test('transcript segments keep order and replace in place', () => {
  const t = createTranscript();
  t.append('a', 'open ');
  t.append('a', 'ste');
  t.set('b', 'then');
  t.set('a', 'open steam');
  assert.equal(t.value(), 'open steam then');
});

test('Muse session: key in the first frame, audio buffered until ack, partials stream', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const got = { frames: [], binary: 0 };
  wss.on('connection', (sock) => {
    sock.on('message', (data, binary) => {
      if (binary) {
        got.binary++;
        if (got.binary === 2) {
          sock.send(JSON.stringify({ type: 'transcript', transcript: 'open', final: false }));
          sock.send(JSON.stringify({ type: 'transcript', transcript: 'open steam', final: false }));
        }
        return;
      }
      const m = JSON.parse(data);
      got.frames.push(m);
      if (m.authorization) setTimeout(() => sock.send(JSON.stringify({ sessionId: 's1' })), 20);
      if (m.type === 'endStream') sock.send(JSON.stringify({ type: 'transcript', transcript: 'open steam', final: true }));
    });
  });
  const caps = [];
  const c = createCaptions({
    config: { captions: { engine: 'muse', museUrl: `ws://127.0.0.1:${port}`, keywords: ['Butler'] } },
    env: { META_API_KEY: 'LLM|1|s' },
    onCaption: (x) => caps.push(x),
  });
  assert.equal(c.start('ptt'), true);
  c.audio(new Int16Array(10).buffer); // before the ack: must be queued, not dropped
  await new Promise((r) => setTimeout(r, 80));
  c.audio(new Int16Array(10).buffer);
  await new Promise((r) => setTimeout(r, 60));
  c.stop();
  await new Promise((r) => setTimeout(r, 80));
  wss.close();
  const hello = got.frames[0];
  assert.equal(hello.authorization.accessToken, 'LLM|1|s');
  assert.equal(hello.mode, 'PUSH_TO_TALK');
  assert.equal(hello.audioEncoding, 'PCM_24KHZ');
  assert.equal(got.binary, 2);
  assert.deepEqual(caps.map((x) => [x.text, x.final]), [['open', false], ['open steam', false], ['open steam', true]]);
});

test('a new turn ignores the old turn\'s late events', () => {
  const caps = [];
  const c = createCaptions({ config: { captions: { engine: 'muse', museUrl: 'ws://127.0.0.1:1' } }, env: { META_API_KEY: 'k' }, onCaption: (x) => caps.push(x) });
  c.start();
  c.start();
  c.stop();
  assert.equal(caps.length, 0);
});
