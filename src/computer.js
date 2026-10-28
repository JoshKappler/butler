// Computer-use tasks: gpt-6-astra looks at the screen and drives the mouse and
// keyboard through winhost until the goal is met. Runs in the background; the
// voice session hears about progress, questions and the result.
const { responsesText } = require('./lanes');

const INSTRUCTIONS = `You operate Josh's Windows 11 PC to finish the task you are given. Work fast: batch actions when the next steps are obvious, and prefer keyboard shortcuts (Win+R, Ctrl+L, Alt+Tab) when they are quicker than clicking.
Use Josh's existing logged-in browser sessions and saved passwords; never type a password you were not given.
Call ask_josh and wait before you: pay or place an order, accept terms for a new account, send a message or email, delete anything, or when you are unsure which option he wants. Put everything he needs to decide in the question (price, plan, shipping, what will be sent).
When the task is finished, stop acting and reply with one or two sentences saying what you did.`;

const ASK_TOOL = {
  type: 'function',
  name: 'ask_josh',
  description: 'Ask Josh a question and wait for his spoken or typed answer. Use before purchases, sign-ups, sending messages, deleting, or when a choice is his.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: 'One short question with the facts he needs to decide.' } },
    required: ['question'],
    additionalProperties: false,
  },
  strict: true,
};

// The model sees a downscaled screenshot; map its pixels back to the desktop.
function toScreen(shot, x, y) {
  return { x: Math.round(shot.x + x / shot.scale), y: Math.round(shot.y + y / shot.scale) };
}

// computer-use key names ("CTRL", "ArrowLeft", "Return") to winhost names.
function normalizeKey(k) {
  const s = String(k).trim().toLowerCase();
  const map = { control: 'ctrl', cmd: 'win', command: 'win', super: 'win', meta: 'win', option: 'alt', return: 'enter', esc: 'escape', del: 'delete', pgup: 'pageup', pgdn: 'pagedown' };
  if (map[s]) return map[s];
  if (s.startsWith('arrow')) return s.slice(5);
  return s;
}

async function runAction(winhost, shot, a) {
  const pt = (x, y) => toScreen(shot, x, y);
  const hold = async (keys, fn) => {
    const ks = (keys || []).map(normalizeKey);
    for (const k of ks) await winhost.call('key_state', { key: k, up: false });
    try { await fn(); } finally { for (const k of ks.reverse()) await winhost.call('key_state', { key: k, up: true }); }
  };
  switch (a.type) {
    case 'click': {
      const p = pt(a.x, a.y);
      return hold(a.keys, () => winhost.call('click', { x: p.x, y: p.y, button: a.button === 'wheel' ? 'middle' : a.button || 'left' }));
    }
    case 'double_click': {
      const p = pt(a.x, a.y);
      return hold(a.keys, () => winhost.call('click', { x: p.x, y: p.y, count: 2 }));
    }
    case 'move': {
      const p = pt(a.x, a.y);
      return winhost.call('move', p);
    }
    case 'drag': {
      const path = (a.path || []).map((q) => pt(q.x, q.y));
      if (!path.length) return;
      return hold(a.keys, async () => {
        await winhost.call('move', path[0]);
        await winhost.call('button', { button: 'left', up: false });
        for (const q of path.slice(1)) { await winhost.call('move', q); await sleep(16); }
        await winhost.call('button', { button: 'left', up: true });
      });
    }
    case 'scroll': {
      const p = pt(a.x, a.y);
      // The model scrolls in pixels; one wheel notch is roughly 100.
      const notches = (v) => (v ? Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 100)) : 0);
      return hold(a.keys, () => winhost.call('scroll', { x: p.x, y: p.y, dx: notches(a.scroll_x), dy: notches(a.scroll_y) }));
    }
    case 'keypress':
      return winhost.call('keys', { keys: a.keys.map(normalizeKey) });
    case 'type':
      return winhost.call('type', { text: a.text });
    case 'wait':
      return sleep(1000);
    case 'screenshot':
      return;
    default:
      throw new Error(`unsupported action ${a.type}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createComputer({ lanes, winhost, config, emit = () => {}, ask, hideOverlay = async () => {} }) {
  const tasks = new Map();
  let nextId = 1;

  async function screenshot() {
    await hideOverlay();
    return winhost.call('screenshot', {
      monitor: config.computer.monitor ?? -1,
      max_edge: config.computer.maxEdge || 1600,
      format: 'png',
    }, { timeout: 20000 });
  }

  function imageItem(callId, shot, acknowledged) {
    const item = {
      type: 'computer_call_output',
      call_id: callId,
      output: { type: 'computer_screenshot', image_url: `data:${shot.mime};base64,${shot.b64}` },
    };
    if (acknowledged && acknowledged.length) item.acknowledged_safety_checks = acknowledged;
    return item;
  }

  async function loop(task) {
    const maxSteps = config.computer.maxSteps || 60;
    let shot = await screenshot();
    let resp = await lanes.responses('computer', {
      instructions: INSTRUCTIONS,
      tools: [{ type: 'computer' }, ASK_TOOL],
      reasoning: { effort: config.computer.effort || 'low' },
      truncation: 'auto',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: task.goal },
          { type: 'input_image', image_url: `data:${shot.mime};base64,${shot.b64}` },
        ],
      }],
    }, { timeoutMs: 120000 });

    for (let step = 0; step < maxSteps; step++) {
      if (task.cancelled) throw new Error('cancelled');
      const calls = (resp.output || []).filter((o) => o.type === 'computer_call' || o.type === 'function_call');
      if (!calls.length) return responsesText(resp) || 'Done.';

      const inputs = [];
      for (const call of calls) {
        if (call.type === 'function_call') {
          let q = 'Continue?';
          try { q = JSON.parse(call.arguments || '{}').question || q; } catch { /* keep default */ }
          task.status = 'asking';
          emit({ type: 'computer', event: 'question', task: pub(task), question: q });
          const answer = await ask(q, task);
          task.status = 'working';
          inputs.push({ type: 'function_call_output', call_id: call.call_id, output: answer || 'No answer. Do not proceed with that step.' });
          continue;
        }
        // Safety checks (suspected prompt injection, sensitive sites) need Josh's ok.
        let acknowledged = [];
        if (call.pending_safety_checks && call.pending_safety_checks.length) {
          const msg = call.pending_safety_checks.map((c) => c.message || c.code).join('; ');
          const answer = await ask(`Safety check: ${msg}. Continue?`, task);
          if (!/^\s*(y|yes|ok|okay|sure|go|continue|do it)\b/i.test(answer || '')) throw new Error(`stopped at safety check: ${msg}`);
          acknowledged = call.pending_safety_checks;
        }
        const actions = call.actions || (call.action ? [call.action] : []);
        for (const a of actions) {
          task.last = describe(a);
          emit({ type: 'computer', event: 'action', task: pub(task) });
          await runAction(winhost, shot, a);
          await sleep(config.computer.actionDelayMs ?? 120);
        }
        await sleep(config.computer.settleMs ?? 400);
        shot = await screenshot();
        inputs.push(imageItem(call.call_id, shot, acknowledged));
      }
      task.steps++;
      resp = await lanes.responses('computer', {
        instructions: INSTRUCTIONS,
        tools: [{ type: 'computer' }, ASK_TOOL],
        reasoning: { effort: config.computer.effort || 'low' },
        truncation: 'auto',
        previous_response_id: resp.id,
        input: inputs,
      }, { timeoutMs: 120000 });
    }
    throw new Error(`hit the ${maxSteps}-step limit`);
  }

  function describe(a) {
    if (a.type === 'type') return `type "${String(a.text).slice(0, 40)}"`;
    if (a.type === 'keypress') return `press ${a.keys.join('+')}`;
    if (a.x !== undefined) return `${a.type} at ${a.x},${a.y}`;
    return a.type;
  }

  function pub(t) {
    return { id: t.id, goal: t.goal, status: t.status, steps: t.steps, last: t.last, result: t.result || null, finished: t.finished || null };
  }

  function start(goal) {
    const task = { id: String(nextId++), goal, status: 'working', steps: 0, last: '', cancelled: false, started: Date.now() };
    tasks.set(task.id, task);
    emit({ type: 'computer', event: 'started', task: pub(task) });
    loop(task).then((result) => {
      task.status = 'done';
      task.result = result;
      task.finished = Date.now();
      emit({ type: 'computer', event: 'done', task: pub(task) });
    }).catch((err) => {
      task.status = task.cancelled ? 'cancelled' : 'failed';
      task.result = err.message;
      task.finished = Date.now();
      emit({ type: 'computer', event: 'failed', task: pub(task) });
    });
    return { id: task.id, status: 'started' };
  }

  function cancel(id) {
    const ids = id === 'all' || !id ? [...tasks.keys()] : [String(id)];
    for (const i of ids) { const t = tasks.get(i); if (t && t.status === 'working') t.cancelled = true; }
    return { cancelled: ids };
  }

  return { start, cancel, list: () => [...tasks.values()].map(pub) };
}

module.exports = { createComputer, toScreen, normalizeKey };
