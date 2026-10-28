// Butler's eyes and, when nothing smarter works, its hands.
//   capture   screenshot of the screen or the focused window, remembered so
//             coordinates in it can be mapped back to the desktop
//   describe  ask the vision lane about a screenshot (phone and text paths;
//             the voice session sees the image itself)
//   locate    "the Submit button" -> desktop coordinates, grounded by the
//             computer-use model, which is the best at pointing
//   mouse     direct clicks, drags and scrolls: the manual override
const { responsesText } = require('./lanes');

function createScreen({ winhost, lanes, config, log = () => {} }) {
  let last = null;

  async function capture(target = 'screen') {
    const edge = config.vision.maxEdge || 1280;
    let shot;
    let title = '';
    if (target === 'window') {
      const fg = await winhost.call('foreground').catch(() => null);
      if (fg && !fg.minimized && fg.w > 40 && fg.h > 40) {
        title = fg.title;
        shot = await winhost.call('screenshot', { rect: { x: fg.x, y: fg.y, w: fg.w, h: fg.h }, max_edge: edge, format: 'jpeg' }, { timeout: 20000 });
      }
    }
    if (!shot) shot = await winhost.call('screenshot', { monitor: config.vision.monitor ?? -1, max_edge: edge, format: 'jpeg' }, { timeout: 20000 });
    last = { x: shot.x, y: shot.y, w: shot.w, h: shot.h, scale: shot.scale, at: Date.now() };
    return { ...last, title, target, dataUrl: `data:${shot.mime};base64,${shot.b64}` };
  }

  // Image pixels of the last capture -> desktop pixels.
  function toDesktop(ix, iy) {
    if (!last) throw new Error('no screenshot yet: call look first');
    return { x: Math.round(last.x + Number(ix) / last.scale), y: Math.round(last.y + Number(iy) / last.scale) };
  }

  async function describe(question, shot) {
    const r = await lanes.turn('vision', {
      instructions: 'You are looking at a screenshot of Josh\'s Windows PC. Answer the question directly and briefly. Quote exact text when it matters (errors, numbers, names).',
      messages: [lanes.imageMessage('vision', question || 'What is on the screen? Summarize what matters in two sentences.', shot.dataUrl)],
      maxTokens: 500,
    }, { timeoutMs: 30000 });
    return r.text;
  }

  // One computer-use turn that must answer with a single pointing action. The
  // model sees the screenshot at the size it was captured, so its x/y are image
  // pixels of this capture.
  async function locate(description, target = 'screen') {
    const shot = await capture(target);
    const resp = await lanes.responses('computer', {
      tools: [{ type: 'computer' }],
      reasoning: { effort: 'low' },
      truncation: 'auto',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `Move the mouse to: ${description}. Do only that one move and nothing else. If it is not visible, say so instead.` },
          { type: 'input_image', image_url: shot.dataUrl },
        ],
      }],
    }, { timeoutMs: 45000 });
    for (const item of resp.output || []) {
      if (item.type !== 'computer_call') continue;
      const acts = item.actions || (item.action ? [item.action] : []);
      const a = acts.find((x) => typeof x.x === 'number' && typeof x.y === 'number');
      if (a) return { ...toDesktop(a.x, a.y), image: { x: a.x, y: a.y } };
    }
    throw new Error(responsesText(resp) || `could not find "${description}" on screen`);
  }

  async function point(args) {
    if (args.target) return (await locate(args.target, args.where === 'window' ? 'window' : 'screen'));
    if (args.x === undefined || args.y === undefined) throw new Error('give a target description or x and y');
    return args.coords === 'screen' ? { x: Math.round(args.x), y: Math.round(args.y) } : toDesktop(args.x, args.y);
  }

  async function mouse(args) {
    const action = args.action || 'click';
    if (action === 'scroll') {
      const p = args.target || args.x !== undefined ? await point(args) : {};
      await winhost.call('scroll', { ...p, dx: 0, dy: Math.round(Number(args.amount) || 3) });
      return { ok: true, action, at: p };
    }
    if (action === 'down' || action === 'up') {
      if (args.target || args.x !== undefined) await winhost.call('move', await point(args));
      await winhost.call('button', { button: args.button || 'left', up: action === 'up' });
      return { ok: true, action };
    }
    const p = await point(args);
    switch (action) {
      case 'move': await winhost.call('move', p); break;
      case 'click': await winhost.call('click', { ...p, button: args.button || 'left' }); break;
      case 'right_click': await winhost.call('click', { ...p, button: 'right' }); break;
      case 'double_click': await winhost.call('click', { ...p, count: 2 }); break;
      case 'drag': {
        const to = args.to_target
          ? await locate(args.to_target)
          : args.coords === 'screen' ? { x: Math.round(args.to_x), y: Math.round(args.to_y) } : toDesktop(args.to_x, args.to_y);
        await winhost.call('move', p);
        await winhost.call('button', { button: 'left', up: false });
        // A few intermediate points: many apps ignore a drag that teleports.
        for (let i = 1; i <= 8; i++) {
          await winhost.call('move', { x: Math.round(p.x + ((to.x - p.x) * i) / 8), y: Math.round(p.y + ((to.y - p.y) * i) / 8) });
          await new Promise((r) => setTimeout(r, 16));
        }
        await winhost.call('button', { button: 'left', up: true });
        return { ok: true, action, from: p, to };
      }
      default: throw new Error(`unknown mouse action ${action}`);
    }
    return { ok: true, action, at: p };
  }

  return { capture, describe, locate, mouse, toDesktop, last: () => last };
}

module.exports = { createScreen };
