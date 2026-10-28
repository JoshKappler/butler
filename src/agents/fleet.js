// Butler's view of every coding agent: visible ones living in herdr panes and
// headless ones running as child processes. Spawns them, types into them,
// reads their screens, and raises "needs you" when one is truly waiting on Josh.
const { spawn: spawnProc } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RECIPES, slugify, fillPath } = require('./recipes');

function expand(p) {
  if (!p) return os.homedir();
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// The herdr server passes its environment to every pane. A Butler started from
// a Claude Code shell carries NO_COLOR=1, which turned every pane monochrome.
function herdrLaunchEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^(NO_COLOR|FORCE_COLOR)$/i.test(k)) delete out[k];
  return out;
}

// herdr agent names: letters, digits, dash, underscore.
function agentName(base) {
  return slugify(base).slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6);
}

// Maps a spoken model name ("fable", "opus", "astra") to the CLI's model id.
function resolveModel(config, cli, model) {
  const table = (config.agents.models && config.agents.models[cli]) || {};
  if (!model) return table.default || undefined;
  return table[String(model).toLowerCase()] || model;
}

function cliArgs(config, cli, modelId, { headless, effort } = {}) {
  const c = config.agents[cli] || {};
  const args = [];
  if (modelId) args.push('--model', modelId);
  const level = effort || c.effort;
  if (level) args.push(...(cli === 'codex' ? ['-c', `model_reasoning_effort="${level}"`] : ['--effort', level]));
  args.push(...((headless ? c.headlessArgs : c.interactiveArgs) || []));
  return args;
}

// "Does this finished turn need Josh?" A blocked screen always does; a turn
// that ended is checked by a small model so plain "done" stays quiet.
const CLASSIFY = `You watch a coding agent's terminal for Josh. Below is the end of its screen after it stopped working.
Answer on one line, exactly one of:
NEEDS: <under 12 words: what Josh must decide or provide>
DONE: <under 12 words: what it finished>
Say NEEDS only if the agent is waiting on a decision, credential, approval or answer only Josh can give. Progress reports and summaries are DONE.`;

function parseVerdict(text) {
  const m = String(text || '').match(/\b(NEEDS|DONE)\s*:\s*(.+)/i);
  if (!m) return { needs: false, summary: String(text || '').trim().slice(0, 120) };
  return { needs: m[1].toUpperCase() === 'NEEDS', summary: m[2].trim().slice(0, 160) };
}

function createFleet({ herdr, config, lanes, emit = () => {}, spawnImpl = spawnProc, log = () => {} }) {
  const headless = new Map();
  const status = new Map();
  let seeded = false;
  let pollTimer = null;
  let nextHeadless = 1;

  // Resolves true when herdr was not running and this started it.
  async function ensureHerdr() {
    if (await herdr.alive()) return false;
    const launch = config.herdr.launch;
    if (!launch) throw new Error('herdr is not running and config.herdr.launch is empty');
    spawnImpl(launch[0], launch.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, env: herdrLaunchEnv() }).unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await herdr.alive()) return true;
    }
    throw new Error('herdr did not come up within 15s');
  }

  // Butler's agents share one herdr workspace so they never scatter Josh's own.
  async function butlerWorkspace(cwd) {
    const label = config.herdr.workspaceLabel || 'butler';
    const list = await herdr.workspaces();
    const found = list.find((w) => w.label === label || w.name === label);
    if (found) return { id: found.workspace_id || found.id, created: null };
    const made = await herdr.createWorkspace({ cwd, label });
    return { id: made.workspace.workspace_id || made.workspace.id, created: made };
  }

  function plan(args) {
    const recipe = args.recipe ? RECIPES[args.recipe] : null;
    if (args.recipe && !recipe) throw new Error(`unknown recipe ${args.recipe}. Known: ${Object.keys(RECIPES).join(', ')}`);
    const cli = args.cli || (recipe && recipe.cli) || config.agents.defaultCli || 'claude';
    const model = args.model || (recipe && recipe.model) || undefined;
    const slug = slugify(args.name || args.task);
    const vars = { ...config.paths, slug };
    for (const k of Object.keys(vars)) vars[k] = expand(vars[k]);
    const cwd = expand(args.cwd ? fillPath(args.cwd, vars) : recipe && recipe.cwd ? fillPath(recipe.cwd, vars) : config.paths.defaultCwd);
    const prompt = recipe
      ? recipe.prompt({ task: args.task || '', workers: args.workers, blender: config.paths.blender })
      : args.task || '';
    return {
      cli, model, modelId: resolveModel(config, cli, model), cwd, prompt,
      name: agentName(args.name || args.recipe || cli), recipe: args.recipe || null,
      effort: args.effort,
    };
  }

  // A herdr started just now opens with an empty workspace of its own; closing
  // it leaves only the agent's.
  async function closeStarter(created) {
    const mine = created.workspace.workspace_id || created.workspace.id;
    const others = (await herdr.workspaces()).filter((w) => (w.workspace_id || w.id) !== mine);
    if (others.length === 1 && others[0].pane_count === 1) await herdr.closeWorkspace(others[0].workspace_id || others[0].id);
  }

  async function spawnVisible(p, space) {
    const launched = await ensureHerdr();
    const ws = space
      ? { created: await herdr.createWorkspace({ cwd: p.cwd, label: p.name, focus: true }) }
      : await butlerWorkspace(p.cwd);
    if (space && launched) await closeStarter(ws.created).catch((err) => log(`herdr starter workspace: ${err.message}`));
    // A fresh workspace already has an empty root pane; use it instead of a new tab.
    let pane;
    if (ws.created && ws.created.root_pane) pane = ws.created.root_pane.pane_id;
    else pane = (await herdr.createTab({ workspace: ws.id, cwd: p.cwd, label: p.name })).root_pane.pane_id;
    await herdr.startAgent({ name: p.name, kind: p.cli, pane, args: cliArgs(config, p.cli, p.modelId, { effort: p.effort }) });
    if (p.prompt) await herdr.prompt(p.name, p.prompt);
    return { name: p.name, pane, cli: p.cli, model: p.modelId || 'default', cwd: p.cwd, visible: true };
  }

  // Headless runs take the prompt on stdin, which keeps quoting out of the
  // command line and lets .cmd shims run through the shell safely.
  function spawnHeadless(p) {
    const c = config.agents[p.cli] || {};
    const bin = c.bin || p.cli;
    let args;
    let lastFile = null;
    if (p.cli === 'codex') {
      lastFile = path.join(os.tmpdir(), `butler-codex-${Date.now()}.txt`);
      args = ['exec', '--skip-git-repo-check', '--output-last-message', lastFile, ...cliArgs(config, 'codex', p.modelId, { headless: true, effort: p.effort }), '-'];
    } else {
      args = ['-p', '--output-format', 'stream-json', '--verbose', ...cliArgs(config, 'claude', p.modelId, { headless: true, effort: p.effort })];
    }
    const id = `h${nextHeadless++}`;
    const rec = {
      name: p.name, id, cli: p.cli, model: p.modelId || 'default', cwd: p.cwd, task: p.prompt.slice(0, 200),
      status: 'working', output: '', result: '', last: '', started: Date.now(), child: null,
    };
    fs.mkdirSync(p.cwd, { recursive: true });
    const child = spawnImpl(bin, args, {
      cwd: p.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32',
    });
    rec.child = child;
    child.stdin.end(p.prompt);
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = String(d);
      rec.output = (rec.output + s).slice(-20000);
      if (p.cli !== 'claude') return;
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') rec.result = ev.result || '';
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'tool_use') rec.last = `${c.name}`;
              if (c.type === 'text' && c.text) rec.last = c.text.slice(0, 120);
            }
            emit({ type: 'agent', event: 'progress', agent: publicRec(rec) });
          }
        } catch { /* partial or non-JSON line */ }
      }
    });
    child.stderr.on('data', (d) => { rec.output = (rec.output + String(d)).slice(-20000); });
    child.on('error', (err) => finish(rec, 'failed', `spawn error: ${err.message}`));
    child.on('close', (code) => {
      if (lastFile) {
        try { rec.result = fs.readFileSync(lastFile, 'utf8'); fs.unlinkSync(lastFile); } catch { /* none written */ }
      }
      finish(rec, code === 0 ? 'done' : 'failed');
    });
    const timeoutMin = config.agents.headlessTimeoutMinutes || 30;
    rec.timer = setTimeout(() => { if (rec.status === 'working') { rec.status = 'timeout'; child.kill(); } }, timeoutMin * 60000);
    headless.set(p.name, rec);
    return { name: p.name, cli: p.cli, model: rec.model, cwd: p.cwd, visible: false };
  }

  function finish(rec, st, note) {
    if (rec.finished) return;
    clearTimeout(rec.timer);
    rec.finished = Date.now();
    if (rec.status === 'working') rec.status = st;
    if (note) rec.output += `\n${note}`;
    const summary = (rec.result || rec.output).trim().slice(-600);
    emit({ type: 'agent', event: rec.status === 'done' ? 'done' : 'failed', agent: publicRec(rec), summary });
  }

  function publicRec(r) {
    return {
      name: r.name, cli: r.cli, model: r.model, status: r.status, cwd: r.cwd, visible: false,
      task: r.task, last: r.last, minutes: Math.round(((r.finished || Date.now()) - r.started) / 60000),
    };
  }

  async function spawn(args) {
    const p = plan(args);
    const visible = args.visible !== undefined ? !!args.visible : config.agents.visibleByDefault !== false;
    const out = visible ? await spawnVisible(p, args.space !== false) : spawnHeadless(p);
    emit({ type: 'agent', event: 'spawned', agent: out });
    return out;
  }

  async function list() {
    let visible = [];
    try {
      visible = (await herdr.agents()).map((a) => ({
        name: a.name || a.pane_id, pane: a.pane_id, cli: a.agent || a.display_agent || '?',
        status: a.agent_status, cwd: a.cwd || a.foreground_cwd || '', title: a.terminal_title_stripped || a.title || '',
        visible: true, focused: !!a.focused,
      }));
    } catch (err) {
      log(`fleet: herdr list failed: ${err.message}`);
    }
    return [...visible, ...[...headless.values()].map(publicRec)];
  }

  async function read(target, lines = 60) {
    const h = headless.get(target);
    if (h) return (h.result || h.output).split('\n').slice(-lines).join('\n');
    return herdr.read(target, lines);
  }

  async function tell(target, text) {
    if (headless.has(target)) throw new Error('headless agents take no input; spawn a visible one to converse');
    await herdr.prompt(target, text);
    return { ok: true };
  }

  async function keys(target, keyList) {
    await herdr.sendKeys(target, keyList);
    return { ok: true };
  }

  async function stop(target) {
    const h = headless.get(target);
    if (h) {
      if (h.child && h.status === 'working') { h.status = 'stopped'; h.child.kill(); }
      return { ok: true };
    }
    const a = (await herdr.agents()).find((x) => x.name === target || x.pane_id === target);
    if (!a) throw new Error(`no agent ${target}`);
    await herdr.closePane(a.pane_id);
    return { ok: true, closed: a.pane_id };
  }

  async function classify(agent) {
    if (!lanes) return { needs: false, summary: 'finished' };
    try {
      const screen = await herdr.read(agent.pane_id, 60);
      return parseVerdict(await lanes.ask('fast', CLASSIFY, screen.slice(-6000), { maxTokens: 60, timeoutMs: 15000 }));
    } catch (err) {
      log(`fleet: classify failed: ${err.message}`);
      return { needs: false, summary: 'finished' };
    }
  }

  // One poll of herdr's agent list; emits on every status transition. The first
  // poll only seeds, so Butler starting up never chimes for old states.
  async function poll() {
    let agents;
    try { agents = await herdr.agents(); } catch { return; }
    const seen = new Set();
    for (const a of agents) {
      const key = a.pane_id;
      seen.add(key);
      const prev = status.get(key);
      const cur = a.agent_status;
      status.set(key, cur);
      if (!seeded || prev === cur) continue;
      const pub = { name: a.name || a.pane_id, pane: a.pane_id, cli: a.agent || '?', status: cur, cwd: a.cwd || '' };
      emit({ type: 'agent', event: 'status', agent: pub, from: prev || null });
      if (cur === 'blocked') {
        emit({ type: 'agent', event: 'needs_input', agent: pub, summary: 'waiting on an approval or question' });
      } else if (cur === 'done' && prev === 'working') {
        const v = await classify(a);
        emit({ type: 'agent', event: v.needs ? 'needs_input' : 'done', agent: pub, summary: v.summary });
      }
    }
    for (const key of [...status.keys()]) if (!seen.has(key)) status.delete(key);
    seeded = true;
  }

  function startWatching() {
    if (pollTimer) return;
    const every = config.agents.pollMs || 2000;
    const loop = async () => {
      await poll();
      pollTimer = setTimeout(loop, every);
    };
    loop();
  }

  function stopWatching() {
    clearTimeout(pollTimer);
    pollTimer = null;
    for (const h of headless.values()) if (h.child && h.status === 'working') h.child.kill();
  }

  return { spawn, list, read, tell, keys, stop, focus: (t) => herdr.focus(t), poll, startWatching, stopWatching, plan };
}

module.exports = { createFleet, parseVerdict, resolveModel, cliArgs };
