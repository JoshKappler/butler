const test = require('node:test');
const assert = require('node:assert');
const { createSession, sessionBody, historyInput, liveInstructions } = require('../src/voice/live');

const config = { persona: 'You are Butler.', voice: { live: { model: 'gpt-live-1', voice: 'meridian', idleSeconds: 30 } } };
const chat = (n, size = 10) => ({ turns: Array.from({ length: n }, (_, i) => ({ heard: `q${i}`.padEnd(size, '.'), answer: `a${i}`.padEnd(size, '.') })) });

test('a live session is a client-delegation GPT-Live call over WebRTC', () => {
  const body = sessionBody(config, { sdp: 'v=0', instructions: 'be brief', input: [] });
  assert.deepEqual(body, {
    session: { model: 'gpt-live-1', instructions: 'be brief', input: [], audio: { output: { voice: 'meridian' } }, delegation: { type: 'client' } },
    transport: { type: 'webrtc', sdp: 'v=0' },
  });
});

test('the live prompt keeps the policy headings and the desk snapshot', () => {
  const p = liveInstructions(config, { time: 'Fri 5:12 PM' });
  for (const h of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:', 'Delegate to the backend when:', 'Do not delegate to the backend when:']) assert.ok(p.includes(h), h);
  assert.ok(p.startsWith('You are Butler.'));
  assert.ok(p.includes('- Time: Fri 5:12 PM'));
});

test('history seeds the session with the chat as user and assistant messages', () => {
  assert.deepEqual(historyInput(null), []);
  assert.deepEqual(historyInput({ turns: [{ heard: 'how many gallons is 5 liters', answer: 'About 1.3.' }] }), [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how many gallons is 5 liters' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'About 1.3.' }] },
  ]);
});

test('history keeps the newest exchanges inside the turn and size budgets, oldest first', () => {
  const byTurns = historyInput(chat(30), { turns: 3 });
  assert.deepEqual(byTurns.map((m) => m.content[0].text.slice(0, 3)), ['q27', 'a27', 'q28', 'a28', 'q29', 'a29']);
  // Each exchange is 20 characters: 50 fit exactly, the 51st does not.
  assert.equal(historyInput(chat(60), { turns: 60, maxChars: 1000 }).length, 100);
  assert.equal(historyInput(chat(60), { turns: 60, maxChars: 1000 })[0].content[0].text.slice(0, 3), 'q10');
  // GPT-Live takes at most 128 messages.
  assert.equal(historyInput(chat(100), { turns: 100, maxChars: 1e6 }).length, 128);
});

test('createSession posts the offer and returns the SDP answer', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } }) }; };
  const out = await createSession(config, { sdp: 'offer', instructions: 'i', input: [] }, { fetchImpl, env: { OPENAI_API_KEY: 'k' } });
  assert.deepEqual(out, { id: 'live_1', sdp: 'answer' });
  assert.equal(seen.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(seen.opts.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(seen.opts.body).transport.sdp, 'offer');
});

test('a rejected session never repeats the key the error quotes', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided: sk-proj-ab12****wxyz.' } }) });
  await assert.rejects(createSession(config, { sdp: 'o' }, { fetchImpl, env: { OPENAI_API_KEY: 'k' } }), (err) => {
    assert.equal(err.message, 'live session 401: Incorrect API key provided: sk-….');
    return true;
  });
  await assert.rejects(createSession(config, { sdp: 'o' }, { fetchImpl, env: {} }), /OPENAI_API_KEY is not set/);
});
