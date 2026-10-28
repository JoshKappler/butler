const test = require('node:test');
const assert = require('node:assert');
const { createComputer, toScreen, normalizeKey } = require('../src/computer');

test('image pixels map back to screen pixels', () => {
  const shot = { x: -1920, y: 0, scale: 0.5 };
  assert.deepEqual(toScreen(shot, 100, 50), { x: -1720, y: 100 });
});

test('computer-use key names become winhost names', () => {
  assert.deepEqual(['CTRL', 'ArrowLeft', 'Return', 'CMD', 'a'].map(normalizeKey), ['ctrl', 'left', 'enter', 'win', 'a']);
});

test('loop runs batched actions, returns screenshots, and finishes', async () => {
  const ops = [];
  const winhost = {
    call: async (op, args) => {
      ops.push([op, args]);
      if (op === 'screenshot') return { w: 800, h: 450, x: 0, y: 0, scale: 0.5, mime: 'image/png', b64: 'AAAA' };
      return true;
    },
  };
  const bodies = [];
  const replies = [
    { id: 'r1', output: [{ type: 'computer_call', call_id: 'c1', pending_safety_checks: [], actions: [
      { type: 'click', button: 'left', x: 100, y: 40 },
      { type: 'type', text: 'hello' },
      { type: 'keypress', keys: ['CTRL', 'S'] },
    ] }] },
    { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Saved the file.' }] }] },
  ];
  const lanes = { responses: async (lane, body) => { bodies.push({ lane, ...body }); return replies.shift(); } };
  const config = { computer: { maxSteps: 5, actionDelayMs: 0, settleMs: 0 } };
  const events = [];
  const computer = createComputer({ lanes, winhost, config, emit: (e) => events.push(e), ask: async () => 'yes' });
  computer.start('save the file');
  await new Promise((r) => setTimeout(r, 50));
  const done = events.find((e) => e.event === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.task.result, 'Saved the file.');
  assert.deepEqual(ops.find((o) => o[0] === 'click')[1], { x: 200, y: 80, button: 'left' });
  assert.deepEqual(ops.find((o) => o[0] === 'keys')[1], { keys: ['ctrl', 's'] });
  assert.equal(bodies[0].tools[0].type, 'computer');
  assert.equal(bodies[1].previous_response_id, 'r1');
  assert.equal(bodies[1].input[0].type, 'computer_call_output');
  assert.match(bodies[1].input[0].output.image_url, /^data:image\/png;base64,/);
});

test('ask_josh pauses the loop for an answer', async () => {
  const winhost = { call: async (op) => (op === 'screenshot' ? { x: 0, y: 0, scale: 1, mime: 'image/png', b64: 'A' } : true) };
  const replies = [
    { id: 'r1', output: [{ type: 'function_call', name: 'ask_josh', call_id: 'f1', arguments: '{"question":"Buy for $20?"}' }] },
    { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ordered.' }] }] },
  ];
  const bodies = [];
  const lanes = { responses: async (lane, b) => { bodies.push(b); return replies.shift(); } };
  const asked = [];
  const config = { computer: { actionDelayMs: 0, settleMs: 0 } };
  const events = [];
  const c = createComputer({ lanes, winhost, config, emit: (e) => events.push(e), ask: async (q) => { asked.push(q); return 'yes, go'; } });
  c.start('buy the thing');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(asked, ['Buy for $20?']);
  assert.deepEqual(bodies[1].input[0], { type: 'function_call_output', call_id: 'f1', output: 'yes, go' });
  assert.ok(events.find((e) => e.event === 'done'));
});

test('a refused safety check stops the task', async () => {
  const winhost = { call: async (op) => (op === 'screenshot' ? { x: 0, y: 0, scale: 1, mime: 'image/png', b64: 'A' } : true) };
  const lanes = { responses: async () => ({ id: 'r1', output: [{ type: 'computer_call', call_id: 'c1', pending_safety_checks: [{ id: 's1', message: 'possible injection' }], actions: [] }] }) };
  const events = [];
  const c = createComputer({ lanes, winhost, config: { computer: {} }, emit: (e) => events.push(e), ask: async () => 'no' });
  c.start('x');
  await new Promise((r) => setTimeout(r, 50));
  const failed = events.find((e) => e.event === 'failed');
  assert.match(failed.task.result, /safety check/);
});
