const test = require('node:test');
const assert = require('node:assert');
const { createTurns, wav, parseReply } = require('../src/voice/turns');

const config = { persona: 'You are Butler.', voice: { chatGapMinutes: 180, historyTurns: 3 } };
const context = async () => ({ time: 'now', agents: [], routines: [], tasks: [], pending: [] });
const tools = { schemas: () => [], execute: async () => ({ ok: true }) };
// 4800 samples of PCM16 at a steady level; 3000 of 32768 is about 0.09, a spoken peak.
const clip = (amp) => new Int16Array(4800).map((_, i) => (i % 2 ? amp : -amp)).buffer;
const speech = () => clip(3000);

test('wav wraps PCM16 mono in a 44-byte header', () => {
  const w = wav(Buffer.alloc(480), 24000);
  assert.equal(w.length, 524);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(w.readUInt32LE(28), 48000);
  assert.equal(w.readUInt32LE(40), 480);
});

test('replies split into what to say and what goes in the dock', () => {
  assert.deepEqual(parseReply('A: Opening Steam.'), { answer: 'Opening Steam.', dock: '' });
  assert.deepEqual(parseReply('A:'), { answer: '', dock: '' });
  assert.deepEqual(parseReply('Just the answer.'), { answer: 'Just the answer.', dock: '' });
  assert.deepEqual(parseReply('A: Steps are in the dock.\nDOCK:\n1. Load rockets\n2. Fire'), { answer: 'Steps are in the dock.', dock: '1. Load rockets\n2. Fire' });
});

test('the voice lane answers the hear lane transcript, never the audio', async () => {
  const asked = [];
  const lanes = {
    // Both lanes could take audio; only hear may get it.
    audioMessage: (lane) => ({ role: 'user', parts: [`audio for ${lane}`] }),
    turn: async (lane, o) => { asked.push([lane, o.messages[0].parts[0]]); return { text: ' How many gallons is 5 L? ' }; },
    agent: async (lane, o) => { asked.push([lane, o.task]); return 'A: About one point three.'; },
  };
  const turns = createTurns({ config, lanes, tools, context });
  const out = await turns.run({ pcm: speech(), rate: 24000 });
  assert.deepEqual(out, { heard: 'How many gallons is 5 L?', answer: 'About one point three.' });
  assert.deepEqual(asked, [['hear', 'audio for hear'], ['voice', 'How many gallons is 5 L?']]);
});

test('a recording with no speech never reaches the voice lane', async () => {
  let answered = false;
  const lanes = {
    audioMessage: () => ({ role: 'user', parts: ['audio'] }),
    turn: async () => ({ text: '' }),
    agent: async () => { answered = true; return 'A: Which one of these has the best reviews?'; },
  };
  const turns = createTurns({ config, lanes, tools, context });
  assert.deepEqual(await turns.run({ pcm: speech(), rate: 24000 }), { heard: '', answer: '' });
  assert.equal(answered, false);
});

test('a silent recording is never transcribed, so nothing can be made up from it', async () => {
  const heard = [];
  const lanes = {
    audioMessage: () => ({ role: 'user', parts: ['audio'] }),
    turn: async () => { heard.push('hear'); return { text: 'and look for the next thing' }; },
    agent: async () => { heard.push('voice'); return 'A: There are no pinned contracts.'; },
  };
  const turns = createTurns({ config, lanes, tools, context });
  // 10 of 32768 is 0.0003, the level the dead mic logged.
  assert.deepEqual(await turns.run({ pcm: clip(10), rate: 24000 }), { heard: '', answer: '' });
  assert.deepEqual(await turns.run({ pcm: new ArrayBuffer(9600), rate: 24000 }), { heard: '', answer: '' });
  assert.deepEqual(heard, []);
  // Quiet speech at 0.006 still goes through.
  await turns.run({ pcm: clip(200), rate: 24000 });
  assert.deepEqual(heard, ['hear', 'voice']);
});

test('a request GPT-Live delegates runs on the delegate lane and is left for the live engine to record', async () => {
  const seen = [];
  const shown = [];
  const lanes = { agent: async (lane, o) => { seen.push([lane, o.instructions]); return 'A: Steam is open.\nDOCK:\n- Library'; } };
  const showTools = { schemas: () => [], execute: async (name, args) => { shown.push(args.markdown); return { shown: true }; } };
  const turns = createTurns({ config, lanes, tools: showTools, context });
  assert.deepEqual(await turns.run({ text: 'open steam' }, { delegated: true }), { heard: 'open steam', answer: 'Steam is open.', dock: '- Library' });
  assert.deepEqual(shown, ['- Library']);
  await turns.run({ text: 'thanks' });
  assert.equal(seen[0][0], 'delegate');
  assert.ok(seen[0][1].includes('# You are the backend'));
  assert.equal(seen[1][0], 'voice');
  assert.ok(!seen[1][1].includes('# You are the backend'));
  assert.ok(!seen[1][1].includes('# This conversation so far'));
});

test('the current chat rides along until a three-hour gap starts a new one', async () => {
  let t = 0;
  const seen = [];
  const lanes = { agent: async (lane, o) => { seen.push(o.instructions); return 'A: a'; } };
  const turns = createTurns({ config, lanes, tools, context, now: () => t });
  await turns.run({ text: 'first' });
  t = 8 * 60000; // an eight-minute pause in the middle of a topic: same chat
  await turns.run({ text: 'second' });
  t += 180 * 60000 - 1; // one millisecond short of the gap: same chat
  await turns.run({ text: 'third' });
  t += 180 * 60000; // exactly three hours after the last exchange: a new chat
  await turns.run({ text: 'fourth' });
  assert.ok(!seen[0].includes('# This conversation so far'));
  assert.ok(seen[1].includes('Josh: first\nButler: a'));
  assert.ok(seen[2].includes('Josh: first') && seen[2].includes('Josh: second'));
  assert.ok(!seen[3].includes('# This conversation so far'));
});

test('an exchange with nothing to say is not kept', async () => {
  const seen = [];
  const lanes = { agent: async (lane, o) => { seen.push(o.instructions); return seen.length === 1 ? 'A:' : 'A: a'; } };
  const turns = createTurns({ config, lanes, tools, context });
  await turns.run({ text: 'cough' });
  await turns.run({ text: 'hello' });
  assert.ok(!seen[1].includes('# This conversation so far'));
});

test('dock text in the reply is shown and rides along with its answer', async () => {
  const seen = [];
  const shown = [];
  const lanes = { agent: async (lane, o) => { seen.push(o.instructions); return 'A: Details are in the dock.\nDOCK:\n- Fire button on the dashboard'; } };
  const showTools = { schemas: () => [], execute: async (name, args) => { shown.push([name, args.markdown]); return { shown: true }; } };
  const turns = createTurns({ config, lanes, tools: showTools, context });
  await turns.run({ text: 'how do I use the MLRS' });
  await turns.run({ text: 'how do I fire it' });
  assert.deepEqual(shown[0], ['show', '- Fire button on the dashboard']);
  assert.ok(seen[1].includes('Butler: Details are in the dock.\n(In the dock: - Fire button on the dashboard)'));
});
