// Butler's side of the phone relay (the Vercel app in remote/). Once a second
// it posts what changed (state, events, a screenshot if one was asked for) and
// takes back whatever Josh queued from his phone. Outbound HTTPS only: nothing
// on the PC listens to the internet.
const os = require('os');
const { agentTools } = require('./tools/agent-tools');

const PHONE_INSTRUCTIONS = `You are Butler, Josh's assistant, running on his Windows PC (${os.hostname()}). Josh is messaging you from his phone and is away from the PC, so he cannot see its screen or hear you.
Do what he asks with your tools. Reply in plain text, one to three short sentences; use a short markdown list only for lists. Include paths and links when they matter.
Anything that spends money, sends a message, or deletes things still goes through the usual approval, which Josh answers on his phone.`;

function createRelay({ config, tools, schemas, pending, lanes, winhost, snapshot, log = () => {}, fetchImpl = fetch, env = process.env }) {
  const url = String(config.relay.url || '').replace(/\/$/, '');
  const token = env.BUTLER_PC_TOKEN;
  const outbox = [];
  let lastState = '';
  let screenB64 = null;
  let shot = null; // geometry of the last screenshot, for tap-to-click
  let screenAt = 0;
  let timer = null;
  let backoff = 0;
  let stopped = false;

  const emit = (event) => { outbox.push({ ...event, at: Date.now() }); if (outbox.length > 200) outbox.shift(); };

  // Phone text runs a small tool loop on the "remote" lane with the same tools
  // the voice model has, minus the ones that only make sense at the desk.
  const phoneTools = () => agentTools({
    schemas, execute: tools.execute, exclude: ['end_conversation', 'show'],
    onResult: (name, args, result) => emit({ type: 'result', name, args, result }),
  });

  async function handle(cmd) {
    try {
      switch (cmd.kind) {
        case 'text': {
          emit({ type: 'working', for: cmd.id });
          const ctx = await snapshot();
          const text = await lanes.agent('remote', {
            instructions: `${PHONE_INSTRUCTIONS}\n\nRight now: ${JSON.stringify({ agents: ctx.agents, routines: ctx.routines, pending: ctx.pending }).slice(0, 3000)}`,
            task: String(cmd.text || '').slice(0, 4000),
            tools: phoneTools(),
            maxSteps: 10,
          });
          emit({ type: 'reply', for: cmd.id, text });
          break;
        }
        case 'tool':
          emit({ type: 'result', for: cmd.id, name: cmd.name, args: cmd.args || {}, result: await tools.execute(cmd.name, cmd.args || {}) });
          break;
        case 'answer':
          pending.answer(cmd.qid, String(cmd.answer || ''));
          break;
        case 'screen': {
          const s = await winhost.call('screenshot', { monitor: -1, max_edge: config.relay.screenEdge || 1280, format: 'jpeg' }, { timeout: 20000 });
          shot = s;
          screenB64 = s.b64;
          screenAt = Date.now();
          break;
        }
        case 'click':
        case 'scroll': {
          if (!shot) throw new Error('take a screenshot first');
          const fx = Math.min(1, Math.max(0, Number(cmd.fx))), fy = Math.min(1, Math.max(0, Number(cmd.fy)));
          const x = Math.round(shot.x + (fx * shot.w) / shot.scale);
          const y = Math.round(shot.y + (fy * shot.h) / shot.scale);
          if (cmd.kind === 'scroll') await winhost.call('scroll', { x, y, dx: 0, dy: Math.max(-15, Math.min(15, Math.round(Number(cmd.dy) || 3))) });
          else await winhost.call('click', { x, y, button: cmd.button === 'right' ? 'right' : 'left', count: cmd.double ? 2 : 1 });
          // Show the result of the click without a second tap.
          setTimeout(() => handle({ kind: 'screen' }), 700);
          break;
        }
        case 'type':
          await winhost.call('type', { text: String(cmd.text || '') });
          if (cmd.enter) await winhost.call('keys', { keys: ['enter'] });
          setTimeout(() => handle({ kind: 'screen' }), 500);
          break;
        case 'keys':
          await winhost.call('keys', { keys: String(cmd.keys || '').split('+').filter(Boolean) });
          setTimeout(() => handle({ kind: 'screen' }), 500);
          break;
        default:
          throw new Error(`unknown command ${cmd.kind}`);
      }
    } catch (err) {
      log(`relay ${cmd.kind}: ${err.message}`);
      emit({ type: 'error', for: cmd.id, text: `${cmd.kind} failed: ${err.message}` });
      if (cmd.kind === 'text') emit({ type: 'reply', for: cmd.id, text: `That failed: ${err.message}` });
    }
  }

  async function tick() {
    const body = {};
    const snap = await snapshot().catch(() => null);
    if (snap) {
      const state = { ...snap, host: os.hostname(), quickActions: config.dock.quickActions, screen: { at: screenAt } };
      const json = JSON.stringify(state);
      if (json !== lastState) { body.state = state; lastState = json; }
    }
    const events = outbox.splice(0, 50);
    if (events.length) body.events = events;
    if (screenB64) { body.screen = screenB64; screenB64 = null; }
    try {
      const res = await fetchImpl(`${url}/api/pc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`relay ${res.status}`);
      const { commands = [] } = await res.json();
      backoff = 0;
      for (const c of commands) handle(c); // not awaited: a long task never blocks the loop
    } catch (err) {
      // Put back what did not make it, and try again with growing patience.
      outbox.unshift(...events);
      if (body.state) lastState = '';
      if (body.screen) screenB64 = body.screen;
      if (backoff === 0) log(`relay: ${err.message}`);
      backoff = Math.min(30000, (backoff || 1000) * 2);
    }
  }

  async function loop() {
    if (stopped) return;
    await tick();
    timer = setTimeout(loop, backoff || config.relay.pollMs || 1000);
  }

  return {
    enabled: !!(url && token && token.length >= 32),
    start() { if (this.enabled) loop(); else log('relay: off (set relay.url and BUTLER_PC_TOKEN to enable)'); },
    stop() { stopped = true; clearTimeout(timer); },
    emit,
    tick,
    handle,
  };
}

module.exports = { createRelay };
