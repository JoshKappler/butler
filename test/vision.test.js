const test = require('node:test');
const assert = require('node:assert');
const { createScreen } = require('../src/screen');
const { createLanes } = require('../src/lanes');
const { createTools } = require('../src/tools');
const { createPending } = require('../src/pending');
const { loadConfig } = require('../src/config');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A 2560x1440 monitor at x=-2560 (left of the primary), captured at half size.
function fakeWinhost() {
  const calls = [];
  return {
    calls,
    call: async (op, args) => {
      calls.push([op, args]);
      if (op === 'screenshot') return { x: args.rect ? args.rect.x : -2560, y: args.rect ? args.rect.y : 0, w: 1280, h: 720, scale: 0.5, mime: 'image/jpeg', b64: 'IMG' };
      if (op === 'foreground') return { title: 'Steam', x: 100, y: 50, w: 800, h: 600, minimized: false };
      return true;
    },
  };
}

const config = { vision: { maxEdge: 1280 }, lanes: {}, providers: {} };

test('look at the focused window captures just its rectangle', async () => {
  const wh = fakeWinhost();
  const s = createScreen({ winhost: wh, lanes: {}, config });
  const shot = await s.capture('window');
  assert.deepEqual(wh.calls.find((c) => c[0] === 'screenshot')[1].rect, { x: 100, y: 50, w: 800, h: 600 });
  assert.equal(shot.title, 'Steam');
  assert.match(shot.dataUrl, /^data:image\/jpeg;base64,IMG$/);
});

test('image pixels map back to desktop pixels, even on a left-hand monitor', async () => {
  const s = createScreen({ winhost: fakeWinhost(), lanes: {}, config });
  assert.throws(() => s.toDesktop(1, 1), /call look first/);
  await s.capture('screen');
  assert.deepEqual(s.toDesktop(640, 360), { x: -1280, y: 720 });
});

test('mouse by description: the computer-use model points, Butler clicks', async () => {
  const wh = fakeWinhost();
  const asked = [];
  const lanes = { responses: async (lane, body) => { asked.push([lane, body]); return { output: [{ type: 'computer_call', actions: [{ type: 'move', x: 200, y: 100 }] }] }; } };
  const s = createScreen({ winhost: wh, lanes, config });
  const out = await s.mouse({ action: 'click', target: 'the blue Submit button' });
  assert.equal(asked[0][0], 'computer');
  assert.match(asked[0][1].input[0].content[0].text, /the blue Submit button/);
  assert.deepEqual(out.at, { x: -2560 + 400, y: 200, image: { x: 200, y: 100 } });
  assert.deepEqual(wh.calls.find((c) => c[0] === 'click')[1], { x: -2160, y: 200, image: { x: 200, y: 100 }, button: 'left' });
});

test('mouse drag walks the pointer in steps with the button held', async () => {
  const wh = fakeWinhost();
  const s = createScreen({ winhost: wh, lanes: {}, config });
  await s.capture('screen');
  await s.mouse({ action: 'drag', x: 0, y: 0, to_x: 100, to_y: 0 });
  const ops = wh.calls.map((c) => c[0]);
  assert.deepEqual(ops.filter((o) => o === 'button').length, 2);
  assert.ok(ops.filter((o) => o === 'move').length >= 9);
  assert.deepEqual(wh.calls.filter((c) => c[0] === 'move').at(-1)[1], { x: -2360, y: 0 });
});

test('a target the model cannot find is an error, not a random click', async () => {
  const wh = fakeWinhost();
  const lanes = { responses: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'There is no Submit button.' }] }] }) };
  const s = createScreen({ winhost: wh, lanes, config });
  await assert.rejects(s.mouse({ action: 'click', target: 'Submit' }), /no Submit button/);
  assert.ok(!wh.calls.some((c) => c[0] === 'click'));
});

test('look: the voice session gets the image, the phone path gets words', async () => {
  const cfg = loadConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'butler-')) });
  const screen = { capture: async () => ({ w: 1280, h: 720, target: 'screen', title: '', dataUrl: 'data:image/jpeg;base64,IMG' }), describe: async (q) => `described: ${q}` };
  const tools = createTools({ config: cfg, screen, pending: createPending(), ui: {}, history: { add() {} } });
  const voice = await tools.execute('look', { question: 'what error' });
  assert.equal(voice.attach_image, 'data:image/jpeg;base64,IMG');
  const phone = await tools.execute('look', { question: 'what error', _describe: true });
  assert.equal(phone.answer, 'described: what error');
  assert.equal(phone.attach_image, undefined);
});

test('keyboard hold presses, waits, and always releases', async () => {
  const cfg = loadConfig({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'butler-')) });
  const calls = [];
  const winhost = { call: async (op, a) => { calls.push([op, a]); return true; } };
  const tools = createTools({ config: cfg, winhost, pending: createPending(), ui: {}, history: { add() {} } });
  await tools.execute('keyboard', { hold: 'w', ms: 40 });
  assert.deepEqual(calls, [['key_state', { key: 'w', up: false }], ['key_state', { key: 'w', up: true }]]);
});

// ── Claude through the official SDK ─────────────────────────────────────────
function fakeClaude(replies, seen) {
  return () => ({ beta: { messages: { create: async (body) => { seen.push(JSON.parse(JSON.stringify(body))); return replies.shift(); } } } });
}
const claudeConfig = {
  providers: { anthropic: { kind: 'anthropic', keyEnv: 'K' } },
  lanes: { vision: { provider: 'anthropic', model: 'claude-opus-5' }, fast: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
};

test('Claude lane: images as base64 blocks, low effort, refusal fallback on Opus 5', async () => {
  const seen = [];
  const lanes = createLanes(claudeConfig, { env: { K: 'k' }, anthropicFactory: fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'A build error in main.rs.' }] }], seen) });
  const r = await lanes.turn('vision', { instructions: 'look', messages: [lanes.imageMessage('vision', 'what is this', 'data:image/png;base64,AAA')] });
  assert.equal(r.text, 'A build error in main.rs.');
  const body = seen[0];
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } });
  assert.equal(body.system, 'look');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(body.max_tokens >= 4096);
  assert.equal(body.temperature, undefined);
});

test('Claude lane: tool loop echoes the assistant turn and batches tool results', async () => {
  const seen = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 't1', name: 'peek', input: { path: 'a' } }, { type: 'tool_use', id: 't2', name: 'peek', input: { path: 'b' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Both read.' }] },
  ];
  const lanes = createLanes(claudeConfig, { env: { K: 'k' }, anthropicFactory: fakeClaude(replies, seen) });
  const out = await lanes.agent('fast', { task: 'read a and b', tools: [{ name: 'peek', description: 'd', parameters: { type: 'object', properties: {} }, run: (a) => `contents of ${a.path}` }] });
  assert.equal(out, 'Both read.');
  assert.equal(seen[0].tools[0].input_schema.type, 'object');
  assert.equal(seen[0].fallbacks, undefined, 'no fallback on Haiku');
  const [, asst, results] = seen[1].messages;
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content[0].type, 'thinking', 'thinking blocks go back unchanged');
  assert.deepEqual(results.content.map((c) => [c.type, c.tool_use_id]), [['tool_result', 't1'], ['tool_result', 't2']]);
});

test('Claude lane: a refusal is reported, not treated as an answer', async () => {
  const lanes = createLanes(claudeConfig, { env: { K: 'k' }, anthropicFactory: fakeClaude([{ stop_reason: 'refusal', content: [] }], []) });
  assert.equal((await lanes.turn('vision', { messages: [{ role: 'user', content: 'x' }] })).text, 'Claude declined that request.');
});
