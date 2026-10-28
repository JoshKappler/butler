// The voice model's toolbelt. Quick tools answer in well under a second; the
// slow ones (computer_task, spawn_agent) start background work and return at
// once, and Butler speaks up again when that work lands or needs Josh.
const fs = require('fs');
const path = require('path');
const { needsApproval, runPowerShell, expand } = require('./desktop');
const { listRecipes } = require('../agents/recipes');
const { YES } = require('../pending');

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

function schemas(config) {
  const recipes = listRecipes().map((r) => `${r.name}: ${r.describe}`).join(' | ');
  const f = (name, description, parameters = obj({})) => ({ type: 'function', name, description, parameters });
  return [
    f('open', 'Open an app, website, file or folder by name, URL or path. "steam", "youtube.com", "~/Downloads".',
      obj({ target: str('App name, URL, or path.') }, ['target'])),
    f('find_files', 'Find files or folders on this PC by name words.',
      obj({ query: str('Words in the file name.'), limit: num('Max results, default 15.') }, ['query'])),
    f('ask_files', 'Hand a question about files on this PC to the file-search subagent: "where is my resume", "which project has the herdr fork", "what did I download yesterday". Answers with paths.',
      obj({ question: str('The question, with every detail Josh gave.') }, ['question'])),
    f('read_file', 'Read a text file.',
      obj({ path: str('Absolute path, ~ allowed.'), max_chars: num('Default 6000.') }, ['path'])),
    f('write_file', 'Create or overwrite a text file, or append to it.',
      obj({ path: str('Absolute path, ~ allowed.'), content: str('Full text.'), append: bool('Append instead of overwrite.') }, ['path', 'content'])),
    f('web_search', 'Search the web and get a short sourced answer. Use for anything current or factual you are not sure of.',
      obj({ query: str('What to find out.') }, ['query'])),
    f('run_powershell', 'Run a PowerShell command on this PC. Read-only commands run at once; anything that changes the system waits for Josh to approve in the dock.',
      obj({ command: str('The command.'), reason: str('Why, in a few words, shown to Josh.') }, ['command', 'reason'])),
    f('computer_task', 'Hand a multi-step on-screen job to the computer-use agent: sign up for things, order things, fill forms, operate any app or website. Runs in the background and reports back; it asks Josh before paying, sending or agreeing to anything.',
      obj({ goal: str('The full goal with every detail Josh gave (sizes, budget, accounts, preferences).') }, ['goal'])),
    f('tasks', 'List or cancel computer tasks.',
      obj({ action: str('list or cancel', { enum: ['list', 'cancel'] }), id: str('Task id, or "all".') }, ['action'])),
    f('routine_start', 'Start a repeating action with natural random timing. mouse_jiggle makes a fresh human-looking mouse gesture each run (anti-AFK); key_tap taps a key; remind speaks text.',
      obj({
        kind: str('Routine kind.', { enum: ['mouse_jiggle', 'key_tap', 'remind'] }),
        interval_s: num('Average seconds between runs.'),
        jitter_s: num('Random +/- seconds around the interval.'),
        radius_px: num('mouse_jiggle: gesture size in pixels, default 40.'),
        key: str('key_tap: key name, e.g. space, w, f5.'),
        text: str('remind: what to say.'),
        duration_min: num('Stop automatically after this many minutes.'),
      }, ['kind'])),
    f('routine_stop', 'Stop a routine by id, or "all".', obj({ id: str('Routine id or "all".') }, ['id'])),
    f('spawn_agent', `Start a coding agent (Claude Code or Codex CLI) for real work: code, research, 3D models, animation. Visible agents open in a herdr pane Josh can watch; Butler chimes when one needs him. Recipes: ${recipes}`,
      obj({
        task: str('Self-contained task description.'),
        recipe: str('Optional recipe name.'),
        cli: str('claude or codex.', { enum: ['claude', 'codex'] }),
        model: str('Model name Josh said: fable, opus, sonnet, haiku, astra, sol, luna, or an exact id. Claude defaults to opus.'),
        workers: str('orchestrate recipe: subagent type for the workers, default opus-medium.'),
        effort: str('Reasoning effort: low, medium, high. Claude defaults to high.'),
        cwd: str('Working folder. Defaults to the projects folder or the recipe folder.'),
        name: str('Short name for the agent.'),
        visible: bool('true (default) opens a herdr pane; false runs headless and reports the result.'),
        space: bool('true (default) opens a visible agent in its own new herdr workspace and brings herdr up; false adds it to the shared butler workspace.'),
      }, ['task'])),
    f('agents', 'See and steer coding agents: list them, read an agent\'s screen, type a message to it, send keys (e.g. "1", "enter", "esc" to answer a prompt), focus its pane, or stop it.',
      obj({
        action: str('What to do.', { enum: ['list', 'read', 'tell', 'keys', 'focus', 'stop'] }),
        target: str('Agent name or pane id from list.'),
        text: str('tell: the message.'),
        keys: { type: 'array', items: { type: 'string' }, description: 'keys: key names in order.' },
        lines: num('read: how many lines, default 60.'),
      }, ['action'])),
    f('windows', 'List open windows or focus, minimize, maximize, restore or close one by title or process name.',
      obj({ action: str('What to do.', { enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'] }), target: str('Title or process words.') }, ['action'])),
    f('look', 'See the screen. Use it whenever Josh refers to what is on screen ("this", "that error", "what am I looking at", "read this") or before clicking by hand. The screenshot arrives as the next message.',
      obj({
        question: str('What to look for or answer.'),
        target: str('screen (default) or window (just the focused window, sharper).', { enum: ['screen', 'window'] }),
      })),
    f('mouse', 'Manual mouse control, for when opening, typing or computer_task will not do. Prefer target, a plain description ("the blue Submit button"); it is located precisely for you. Or give x and y in pixels of the last look screenshot.',
      obj({
        action: str('What to do.', { enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'down', 'up'] }),
        target: str('What to point at, described.'),
        x: num('Pixel x in the last look screenshot.'),
        y: num('Pixel y in the last look screenshot.'),
        to_target: str('drag: where to drop, described.'),
        to_x: num('drag: drop x in the last screenshot.'),
        to_y: num('drag: drop y in the last screenshot.'),
        amount: num('scroll: notches, positive is down.'),
        button: str('left, right or middle.', { enum: ['left', 'right', 'middle'] }),
      }, ['action'])),
    f('keyboard', 'Keyboard into the focused app: type text, press a combo like "ctrl+s" or "alt+tab", or hold a key (games: hold "w" for 2000 ms). down/up press or release a key and leave it.',
      obj({
        text: str('Text to type.'),
        keys: str('Combo, keys joined with +.'),
        hold: str('Key to hold down.'),
        ms: num('hold: how long, in ms (max 30000).'),
        down: str('Key to press and leave held.'),
        up: str('Key to release.'),
      })),
    f('media', 'Media and volume keys.',
      obj({ action: str('Key.', { enum: ['play_pause', 'next', 'prev', 'volume_up', 'volume_down', 'mute'] }), times: num('Repeat count, e.g. 5 for five volume steps.') }, ['action'])),
    f('clipboard', 'Read or set the clipboard.', obj({ action: str('get or set', { enum: ['get', 'set'] }), text: str('set: new text.') }, ['action'])),
    f('show', 'Put detail in the dock for Josh to read (lists, links, code, long answers) while you say one short line.',
      obj({ title: str('Short title.'), markdown: str('Body in markdown.') }, ['markdown'])),
    f('answer_pending', 'Pass Josh\'s answer to a question a background task or approval is waiting on.',
      obj({ id: str('Question id, e.g. q3.'), answer: str('His answer in his words, or yes/no.') }, ['id', 'answer'])),
    f('open_herdr', 'Bring up herdr, Josh\'s terminal workspace where the agents live.'),
    f('end_conversation', 'Josh is done talking (thanks, that\'s all, goodbye). Stop listening until he calls again.'),
  ];
}

function createTools(deps) {
  const { config, desktop, winhost, routines, fleet, computer, lanes, filesAgent, screen, pending, ui, history, log = () => {} } = deps;

  async function findWindow(target) {
    const list = await winhost.call('windows');
    const q = String(target || '').toLowerCase();
    const hit = list.find((w) => w.title.toLowerCase().includes(q)) || list.find((w) => w.process.toLowerCase().includes(q));
    if (!hit) throw new Error(`no window matches "${target}"`);
    return hit;
  }

  async function approve(kind, question, from) {
    const q = pending.ask(kind, question, from);
    ui.chime('attention');
    const answer = await q.answer;
    return answer !== null && YES.test(answer);
  }

  const handlers = {
    open: (a) => desktop.open(a.target),
    find_files: (a) => desktop.findFiles(a.query, Math.min(Number(a.limit) || 15, 50)),
    ask_files: async (a) => ({ answer: await filesAgent.ask(a.question) }),

    read_file: (a) => {
      const p = expand(a.path);
      const max = Math.min(Number(a.max_chars) || 6000, 40000);
      const st = fs.statSync(p);
      if (st.isDirectory()) return { dir: p, entries: fs.readdirSync(p).slice(0, 200) };
      const text = fs.readFileSync(p, 'utf8');
      return { path: p, chars: text.length, text: text.slice(0, max), truncated: text.length > max };
    },

    write_file: (a) => {
      const p = expand(a.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (a.append) fs.appendFileSync(p, a.content);
      else fs.writeFileSync(p, a.content);
      return { ok: true, path: p, bytes: Buffer.byteLength(a.content) };
    },

    web_search: async (a) => {
      const r = await lanes.search('search', 'Answer in at most three short sentences for a spoken reply. Lead with the answer. Include numbers and dates when they matter.', a.query);
      return { answer: r.answer, sources: r.sources.slice(0, 5) };
    },

    run_powershell: async (a) => {
      if (needsApproval(a.command)) {
        const ok = await approve('shell', `Run: ${a.command}\nWhy: ${a.reason}`, 'powershell');
        if (!ok) return { denied: true, note: 'Josh did not approve. Do not retry the same command.' };
      }
      return runPowerShell(a.command, { exe: config.shell.exe });
    },

    computer_task: (a) => computer.start(a.goal),
    tasks: (a) => (a.action === 'cancel' ? computer.cancel(a.id || 'all') : computer.list()),

    routine_start: (a) => {
      const { kind, ...params } = a;
      return routines.start(kind, params);
    },
    routine_stop: (a) => routines.stop(a.id),

    spawn_agent: async (a) => {
      const out = await fleet.spawn(a);
      if (out.visible && a.space !== false) await handlers.open_herdr();
      return out;
    },

    agents: async (a) => {
      switch (a.action) {
        case 'list': return fleet.list();
        case 'read': return { screen: await fleet.read(a.target, Number(a.lines) || 60) };
        case 'tell': return fleet.tell(a.target, a.text);
        case 'keys': return fleet.keys(a.target, a.keys || []);
        case 'focus': await fleet.focus(a.target); await handlers.open_herdr(); return { ok: true };
        case 'stop': return fleet.stop(a.target);
        default: throw new Error(`unknown action ${a.action}`);
      }
    },

    windows: async (a) => {
      if (a.action === 'list') return (await winhost.call('windows')).map((w) => ({ title: w.title, process: w.process }));
      const w = await findWindow(a.target);
      if (a.action === 'focus') await winhost.call('focus', { hwnd: w.hwnd });
      else await winhost.call('window', { hwnd: w.hwnd, action: a.action });
      return { ok: true, window: w.title };
    },

    keyboard: async (a) => {
      if (a.keys) await winhost.call('keys', { keys: String(a.keys).split('+') });
      if (a.text) await winhost.call('type', { text: a.text });
      if (a.down) await winhost.call('key_state', { key: a.down, up: false });
      if (a.up) await winhost.call('key_state', { key: a.up, up: true });
      if (a.hold) {
        const ms = Math.min(Math.max(Number(a.ms) || 500, 30), 30000);
        await winhost.call('key_state', { key: a.hold, up: false });
        try { await new Promise((r) => setTimeout(r, ms)); } finally { await winhost.call('key_state', { key: a.hold, up: true }); }
      }
      return { ok: true };
    },

    // The voice session gets the picture itself (attached by the dock as an
    // input_image); callers without eyes of their own (the phone's text agent)
    // pass _describe and get the vision lane's answer instead.
    look: async (a) => {
      const shot = await screen.capture(a.target === 'window' ? 'window' : 'screen');
      const meta = { width: shot.w, height: shot.h, target: shot.target, window: shot.title || undefined };
      if (a._describe) return { ...meta, answer: await screen.describe(a.question, shot) };
      return { ...meta, attach_image: shot.dataUrl, note: 'Screenshot attached as the next message. mouse x/y are pixels in it.' };
    },

    mouse: (a) => screen.mouse(a),

    media: async (a) => {
      const key = { play_pause: 'media_play_pause', next: 'media_next', prev: 'media_prev', volume_up: 'volume_up', volume_down: 'volume_down', mute: 'volume_mute' }[a.action];
      const times = Math.min(Math.max(Number(a.times) || 1, 1), 50);
      for (let i = 0; i < times; i++) await winhost.call('keys', { keys: [key] });
      return { ok: true };
    },

    clipboard: async (a) => (a.action === 'set'
      ? winhost.call('clipboard_set', { text: a.text || '' })
      : { text: String((await winhost.call('clipboard_get')) || '').slice(0, 6000) }),

    show: (a) => { ui.show(a.title || '', a.markdown); return { shown: true }; },

    answer_pending: (a) => ({ delivered: pending.answer(a.id, a.answer) }),

    // herdr's window has no title bar, so it is placed for Josh: the whole
    // monitor named by herdr.monitor ("side" is the right vertical display).
    open_herdr: async () => {
      const title = config.herdr.windowTitle;
      let w = title ? await findWindow(title).catch(() => null) : null;
      if (!w) {
        const [cmd, ...args] = config.herdr.launch;
        await winhost.call('open', { target: cmd, args });
        for (let i = 0; i < 30 && !w && title; i++) {
          await new Promise((r) => setTimeout(r, 500));
          w = await findWindow(title).catch(() => null);
        }
        if (!w) return { launched: true };
      }
      if (config.herdr.monitor) await winhost.call('fill', { hwnd: w.hwnd, monitor: config.herdr.monitor });
      await winhost.call('focus', { hwnd: w.hwnd });
      return { focused: w.title };
    },

    end_conversation: () => { ui.endConversation(); return { ok: true }; },
  };

  // Tools worth offering again from the dock's "recent" list.
  const REPEATABLE = new Set(['open', 'routine_start', 'spawn_agent', 'computer_task', 'web_search', 'open_herdr', 'media']);

  async function execute(name, args = {}) {
    const h = handlers[name];
    if (!h) return { error: `unknown tool ${name}` };
    const started = Date.now();
    try {
      const result = await h(args);
      if (REPEATABLE.has(name)) history.add({ tool: name, args, ok: true, ms: Date.now() - started });
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      log(`tool ${name} failed: ${err.message}`);
      return { error: err.message };
    }
  }

  return { schemas: () => schemas(config), execute, approve };
}

module.exports = { createTools, schemas };
