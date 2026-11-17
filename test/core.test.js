const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { merge, resolvePaths, loadConfig } = require('../src/config');
const { parseWake } = require('../src/voice/wakewatch');
const { sessionBody } = require('../src/voice/session');
const { buildInstructions } = require('../src/voice/instructions');
const { createControl } = require('../src/control');
const { createPending } = require('../src/pending');
const { createTools, schemas } = require('../src/tools');
const { createHistory } = require('../src/history');
const { createHerdr } = require('../src/agents/herdr');
const MD = require('../renderer/md');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'butler-test-'));

test('config merge keeps defaults and takes overrides', () => {
  assert.deepEqual(merge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] }), { a: { b: 1, c: 3 }, d: [2] });
});

test('paths can reference each other', () => {
  const p = resolvePaths({ projects: '/p', mole: '{projects}/MOLE', studio: '{mole}/art' });
  assert.equal(p.studio, '/p/MOLE/art');
});

test('user config.json overrides the defaults', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ voice: { voice: 'ash' } }));
  const cfg = loadConfig({ dir });
  assert.equal(cfg.voice.voice, 'ash');
  assert.equal(cfg.voice.model, 'gpt-realtime-2.1');
});

test('wake word splits off the command said in the same breath', () => {
  const al = ['butler', 'buttler'];
  assert.deepEqual(parseWake('Butler, open Steam.', al), { command: 'open steam' });
  assert.deepEqual(parseWake('hey butler', al), { command: '' });
  assert.equal(parseWake('the butler did it', al).command, 'did it');
  assert.equal(parseWake('open steam', al), null);
});

test('realtime session starts in push-to-talk with tools and transcription', () => {
  const cfg = loadConfig({ dir: tmp() });
  const b = sessionBody(cfg, 'be quick', [{ type: 'function', name: 'open' }]);
  assert.equal(b.session.model, 'gpt-realtime-2.1');
  assert.equal(b.session.audio.input.turn_detection, null);
  assert.equal(b.session.audio.input.transcription.model, cfg.voice.transcribeModel);
  assert.equal(b.session.reasoning.effort, 'low');
  assert.equal(b.session.tools.length, 1);
  assert.equal(b.session.audio.output.speed, 1);
  assert.equal(sessionBody({ ...cfg, voice: { ...cfg.voice, speed: 1.25 } }, '', []).session.audio.output.speed, 1.25);
});

test('instructions carry the live desk context', () => {
  const cfg = loadConfig({ dir: tmp() });
  const text = buildInstructions(cfg, {
    time: 'Fri 9:00 PM', foreground: { title: 'Elden Ring', process: 'eldenring' },
    agents: [{ name: 'lead', cli: 'claude', status: 'blocked' }], routines: [{ id: '1', label: 'mouse gesture every 30s' }],
    tasks: [], pending: [{ id: 'q2', question: 'Buy for $20?' }],
  });
  assert.match(text, /Elden Ring/);
  assert.match(text, /lead \[claude, blocked\]/);
  assert.match(text, /q2: Buy for \$20\?/);
});

test('every tool schema is a valid function definition with a handler', () => {
  const cfg = loadConfig({ dir: tmp() });
  const list = schemas(cfg);
  const tools = createTools({ config: cfg, history: { add() {} }, ui: {}, pending: createPending() });
  const names = new Set();
  for (const s of list) {
    assert.equal(s.type, 'function');
    assert.equal(s.parameters.type, 'object');
    assert.ok(!names.has(s.name), `duplicate ${s.name}`);
    names.add(s.name);
    for (const r of s.parameters.required || []) assert.ok(s.parameters.properties[r], `${s.name} requires missing ${r}`);
  }
  assert.ok(names.has('computer_task') && names.has('spawn_agent') && names.has('routine_start'));
  return tools.execute('nope').then((r) => assert.match(r.error, /unknown tool/));
});

test('tools: routine_start passes params, history records repeatables', async () => {
  const cfg = loadConfig({ dir: tmp() });
  const started = [];
  const added = [];
  const tools = createTools({
    config: cfg, pending: createPending(), ui: {}, history: { add: (e) => added.push(e) },
    routines: { start: (kind, p) => { started.push([kind, p]); return { id: '1' }; } },
  });
  const out = await tools.execute('routine_start', { kind: 'mouse_jiggle', interval_s: 30, jitter_s: 10 });
  assert.deepEqual(out, { id: '1' });
  assert.deepEqual(started[0], ['mouse_jiggle', { interval_s: 30, jitter_s: 10 }]);
  assert.equal(added[0].tool, 'routine_start');
});

test('tools: risky PowerShell waits for approval and a no denies it', async () => {
  const cfg = loadConfig({ dir: tmp() });
  const pending = createPending();
  const chimes = [];
  const tools = createTools({ config: cfg, pending, ui: { chime: (k) => chimes.push(k) }, history: { add() {} } });
  const run = tools.execute('run_powershell', { command: 'Stop-Process -Name notepad', reason: 'close notepad' });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.list().length, 1);
  assert.deepEqual(chimes, ['attention']);
  pending.answer(pending.list()[0].id, 'no');
  assert.equal((await run).denied, true);
});

test('tools: file read and write round trip', async () => {
  const cfg = loadConfig({ dir: tmp() });
  const tools = createTools({ config: cfg, pending: createPending(), ui: {}, history: { add() {} } });
  const file = path.join(tmp(), 'sub', 'note.txt');
  await tools.execute('write_file', { path: file, content: 'hello' });
  await tools.execute('write_file', { path: file, content: ' world', append: true });
  assert.equal((await tools.execute('read_file', { path: file })).text, 'hello world');
});

test('history dedupes by label and persists', () => {
  const dir = tmp();
  const h = createHistory({ dir });
  h.add({ tool: 'open', args: { target: 'steam' } });
  h.add({ tool: 'open', args: { target: 'spotify' } });
  h.add({ tool: 'open', args: { target: 'steam' } });
  const again = createHistory({ dir });
  assert.deepEqual(again.recent().map((r) => r.label), ['Open steam', 'Open spotify']);
});

test('control server requires the token', async () => {
  const dir = tmp();
  let hits = 0;
  const port = 47000 + Math.floor(Math.random() * 900);
  const ctl = createControl({ port, stateDir: dir, routes: { '/key/dock': () => { hits++; } } });
  await new Promise((r) => setTimeout(r, 50));
  const post = (headers) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/key/dock', method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end('{}');
  });
  assert.equal(await post({}), 401);
  assert.equal(await post({ 'X-Butler-Token': ctl.token }), 200);
  assert.equal(hits, 1);
  ctl.close();
});

test('herdr wrapper builds the right argv and scrubs inherited herdr env', async () => {
  process.env.HERDR_SOCKET_PATH = '/tmp/inner.sock';
  const seen = [];
  const exec = (bin, args, opts, cb) => { seen.push({ bin, args, env: opts.env }); cb(null, JSON.stringify({ result: { agents: [] } }), ''); };
  const h = createHerdr({ bin: 'herdr.exe', session: 'weztest', exec });
  await h.startAgent({ name: 'lead', kind: 'claude', pane: 'w1:p1', args: ['--model', 'claude-fable-5-1'] });
  await h.prompt('lead', 'hello there');
  assert.deepEqual(seen[0].args, ['agent', 'start', 'lead', '--kind', 'claude', '--pane', 'w1:p1', '--timeout', '45000', '--', '--model', 'claude-fable-5-1']);
  assert.deepEqual(seen[1].args, ['agent', 'prompt', 'lead', 'hello there']);
  assert.equal(seen[0].env.HERDR_SESSION, 'weztest');
  assert.equal(seen[0].env.HERDR_SOCKET_PATH, undefined);
  delete process.env.HERDR_SOCKET_PATH;
});

test('markdown renderer escapes model output', () => {
  const html = MD.render('# Hi\n- <script>x</script>\n[link](https://a.com)\n```\n<b>\n```');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<h3>Hi<\/h3>/);
  assert.match(html, /<a href="https:\/\/a.com">link<\/a>/);
  assert.match(html, /<pre>&lt;b&gt;<\/pre>/);
});

test('open_herdr fills the side monitor with an open herdr window, then focuses it', async () => {
  const cfg = loadConfig({ dir: tmp() });
  const calls = [];
  const winhost = {
    call: async (op, a) => {
      calls.push([op, a]);
      return op === 'windows' ? [{ hwnd: 42, title: 'herdr', process: 'WindowsTerminal' }] : true;
    },
  };
  const tools = createTools({ config: cfg, pending: createPending(), ui: {}, history: { add() {} }, winhost });
  const out = await tools.execute('open_herdr', {});
  assert.deepEqual(out, { focused: 'herdr' });
  assert.deepEqual(calls.slice(1).map((c) => c[0]), ['fill', 'focus']);
  assert.deepEqual(calls[1][1], { hwnd: 42, monitor: 'side' });
});
