const test = require('node:test');
const assert = require('node:assert');
const { createFleet, parseVerdict, resolveModel, cliArgs } = require('../src/agents/fleet');
const { loadConfig } = require('../src/config');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-test-'));
const config = loadConfig({ dir });

function fakeHerdr(agents = []) {
  const calls = [];
  const h = {
    calls,
    agentsList: agents,
    alive: async () => true,
    workspaces: async () => [{ workspace_id: 'w1', label: 'josh' }],
    createWorkspace: async (a) => { calls.push(['createWorkspace', a]); return { workspace: { workspace_id: 'w9', label: 'butler' }, root_pane: { pane_id: 'w9:p1' } }; },
    createTab: async (a) => { calls.push(['createTab', a]); return { root_pane: { pane_id: 'w9:p2' } }; },
    startAgent: async (a) => { calls.push(['startAgent', a]); },
    prompt: async (t, text) => { calls.push(['prompt', t, text]); },
    agents: async () => h.agentsList,
    read: async () => 'Would you like to proceed?\n1. Yes  2. No',
    sendKeys: async (t, k) => { calls.push(['sendKeys', t, k]); },
    closePane: async (p) => { calls.push(['closePane', p]); },
    closeWorkspace: async (id) => { calls.push(['closeWorkspace', id]); },
  };
  return h;
}

test('spoken model names map to CLI model ids', () => {
  assert.equal(resolveModel(config, 'claude', 'Fable'), 'claude-fable-5-1');
  assert.equal(resolveModel(config, 'claude', 'opus'), 'claude-opus-5-5');
  assert.equal(resolveModel(config, 'codex', 'astra'), 'gpt-6-astra');
  assert.equal(resolveModel(config, 'claude', 'claude-sonnet-5'), 'claude-sonnet-5');
});

test('codex gets its reasoning effort as a config override', () => {
  assert.deepEqual(cliArgs(config, 'codex', 'gpt-6-sol', { effort: 'medium' }), ['--model', 'gpt-6-sol', '-c', 'model_reasoning_effort="medium"']);
});

test('claude defaults to Opus 5.5 at high effort, fast mode off, permissions skipped', () => {
  const fleet = createFleet({ herdr: fakeHerdr(), config });
  const p = fleet.plan({ task: 'fix the build' });
  assert.equal(p.cli, 'claude');
  assert.deepEqual(cliArgs(config, 'claude', p.modelId), [
    '--model', 'claude-opus-5-5', '--effort', 'high', '--settings', '{"fastMode":false}',
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
  ]);
  assert.deepEqual(cliArgs(config, 'claude', 'claude-fable-5-1', { effort: 'low' }).slice(0, 4), ['--model', 'claude-fable-5-1', '--effort', 'low']);
});

test('orchestrate recipe: Opus lead by default, Fable when named, opus-medium workers', () => {
  assert.equal(createFleet({ herdr: fakeHerdr(), config }).plan({ recipe: 'orchestrate', task: 'x' }).modelId, 'claude-opus-5-5');
  const fleet = createFleet({ herdr: fakeHerdr(), config });
  const p = fleet.plan({ recipe: 'orchestrate', model: 'fable', workers: 'opus-medium', task: 'refactor the parser' });
  assert.equal(p.cli, 'claude');
  assert.equal(p.modelId, 'claude-fable-5-1');
  assert.match(p.prompt, /opus-medium/);
  assert.match(p.prompt, /refactor the parser/);
});

test('recipes resolve their working folders', () => {
  const fleet = createFleet({ herdr: fakeHerdr(), config });
  assert.equal(fleet.plan({ recipe: 'mole_animate', task: 'a jog' }).cwd, path.join(config.paths.mole, 'art', 'studio'));
  assert.match(fleet.plan({ recipe: 'model_3d', task: 'A brass pocket watch' }).cwd, /butler-out[\\/]3d[\\/]a-brass-pocket-watch$/);
  assert.throws(() => fleet.plan({ recipe: 'nope', task: 'x' }), /unknown recipe/);
});

test('visible spawn: tab in the butler workspace, agent started, task prompted', async () => {
  const herdr = fakeHerdr();
  herdr.workspaces = async () => [{ workspace_id: 'w3', label: 'butler' }];
  const fleet = createFleet({ herdr, config });
  const out = await fleet.spawn({ cli: 'claude', model: 'opus', task: 'fix the tests', visible: true, space: false });
  assert.equal(out.pane, 'w9:p2');
  const start = herdr.calls.find((c) => c[0] === 'startAgent')[1];
  assert.equal(start.kind, 'claude');
  assert.deepEqual(start.args.slice(0, 2), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(herdr.calls.find((c) => c[0] === 'prompt').slice(1), [out.name, 'fix the tests']);
});

test('first visible spawn creates the butler workspace and uses its root pane', async () => {
  const herdr = fakeHerdr();
  const fleet = createFleet({ herdr, config });
  const out = await fleet.spawn({ cli: 'codex', task: '', visible: true, space: false });
  assert.equal(out.pane, 'w9:p1');
  assert.ok(!herdr.calls.some((c) => c[0] === 'createTab'));
  assert.ok(!herdr.calls.some((c) => c[0] === 'prompt'), 'blank agent gets no prompt');
});

test('a spawn gets its own focused workspace by default, even when the butler one exists', async () => {
  const herdr = fakeHerdr();
  herdr.workspaces = async () => [{ workspace_id: 'w3', label: 'butler' }];
  const fleet = createFleet({ herdr, config });
  const out = await fleet.spawn({ cli: 'claude', task: '' });
  const made = herdr.calls.find((c) => c[0] === 'createWorkspace')[1];
  assert.equal(made.label, out.name);
  assert.equal(made.focus, true);
  assert.equal(out.pane, 'w9:p1');
  assert.ok(!herdr.calls.some((c) => c[0] === 'createTab'));
  assert.ok(!herdr.calls.some((c) => c[0] === 'closeWorkspace'), 'a running herdr keeps its workspaces');
});

test('a herdr started for the agent drops its own empty workspace', async () => {
  const herdr = fakeHerdr();
  let up = false;
  herdr.alive = async () => up;
  herdr.workspaces = async () => [{ workspace_id: 'w1', pane_count: 1 }, { workspace_id: 'w9', pane_count: 1 }];
  const spawnImpl = () => { up = true; return { unref() {} }; };
  const fleet = createFleet({ herdr, config, spawnImpl });
  await fleet.spawn({ cli: 'codex', task: '' });
  assert.deepEqual(herdr.calls.find((c) => c[0] === 'closeWorkspace'), ['closeWorkspace', 'w1']);
});

test('herdr is launched without NO_COLOR, so its panes keep color', async () => {
  const herdr = fakeHerdr();
  let up = false;
  let env = null;
  herdr.alive = async () => up;
  const spawnImpl = (_bin, _args, opts) => { env = opts.env; up = true; return { unref() {} }; };
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    await createFleet({ herdr, config, spawnImpl }).spawn({ cli: 'codex', task: '' });
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
  assert.ok(Object.keys(env).length > 1, 'launch keeps the rest of the environment');
  assert.equal(env.NO_COLOR, undefined);
});

test('verdict parsing', () => {
  assert.deepEqual(parseVerdict('NEEDS: pick a database'), { needs: true, summary: 'pick a database' });
  assert.deepEqual(parseVerdict('done: tests pass'), { needs: false, summary: 'tests pass' });
  assert.equal(parseVerdict('garbage').needs, false);
});

test('poll seeds quietly, then chimes on blocked and classifies done', async () => {
  const herdr = fakeHerdr([{ pane_id: 'w1:p1', name: 'lead', agent: 'claude', agent_status: 'working' }]);
  const events = [];
  const lanes = { ask: async () => 'NEEDS: approve the migration' };
  const fleet = createFleet({ herdr, config, lanes, emit: (e) => events.push(e) });
  await fleet.poll();
  assert.equal(events.length, 0, 'first poll only seeds');
  herdr.agentsList = [{ pane_id: 'w1:p1', name: 'lead', agent: 'claude', agent_status: 'blocked' }];
  await fleet.poll();
  assert.ok(events.some((e) => e.event === 'needs_input'));
  events.length = 0;
  herdr.agentsList = [{ pane_id: 'w1:p1', name: 'lead', agent: 'claude', agent_status: 'working' }];
  await fleet.poll();
  herdr.agentsList = [{ pane_id: 'w1:p1', name: 'lead', agent: 'claude', agent_status: 'done' }];
  await fleet.poll();
  const needs = events.find((e) => e.event === 'needs_input');
  assert.ok(needs, 'a done turn that asks a question counts as needs_input');
  assert.equal(needs.summary, 'approve the migration');
});
