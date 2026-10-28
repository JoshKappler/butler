// Routines: repeating actions that need no model once started, like keeping a
// game from flagging you AFK. Each run is scheduled at interval +/- jitter so
// the rhythm never repeats, and every mouse path is freshly generated.
const MIN_GAP_MS = 1000;

// Smoothstep easing: slow start, slow finish, like a hand.
const ease = (t) => t * t * (3 - 2 * t);

// Integer deltas along a quadratic bezier from (0,0) to (tx,ty). Rounding error
// is carried forward so the deltas sum exactly to the target.
function segment(rand, tx, ty, bend, durationMs) {
  const cx = tx / 2 + bend * -ty;
  const cy = ty / 2 + bend * tx;
  const out = [];
  let t = 0;
  let px = 0, py = 0;
  let fx = 0, fy = 0;
  let elapsed = 0;
  while (t < 1) {
    const step = 7 + Math.floor(rand() * 8);
    elapsed += step;
    t = Math.min(1, elapsed / durationMs);
    const e = ease(t);
    const x = 2 * (1 - e) * e * cx + e * e * tx;
    const y = 2 * (1 - e) * e * cy + e * e * ty;
    // hand tremor, fading out at the ends so the endpoint stays exact
    const wobble = Math.sin(Math.PI * t);
    const nx = x + (rand() - 0.5) * 1.6 * wobble;
    const ny = y + (rand() - 0.5) * 1.6 * wobble;
    fx += nx - px; fy += ny - py;
    px = nx; py = ny;
    const dx = Math.round(fx), dy = Math.round(fy);
    fx -= dx; fy -= dy;
    out.push(dx, dy, step);
  }
  // settle whatever the tremor left over so the segment lands on its target
  const sx = tx - sum(out, 0), sy = ty - sum(out, 1);
  if (sx || sy) out.push(sx, sy, 0);
  return out;
}

function sum(flat, offset) {
  let s = 0;
  for (let i = offset; i < flat.length; i += 3) s += flat[i];
  return s;
}

function pause(ms) { return [0, 0, ms]; }

// A unique, human-looking mouse gesture. Returns flat [dx, dy, delayMs, ...]
// triplets for winhost's PlayPath. With returnHome the net motion is zero, so a
// game camera ends up facing where it started.
function jigglePath(rand = Math.random, radius = 40, returnHome = true) {
  const r = () => radius * (0.35 + rand() * 0.65);
  const angle = () => rand() * Math.PI * 2;
  const bend = () => (rand() - 0.5) * 0.8;
  const dur = () => 180 + rand() * 520;
  const style = ['arc', 'loop', 'zigzag'][Math.floor(rand() * 3)];
  const waypoints = [];
  if (style === 'arc') {
    const a = angle(), d = r();
    waypoints.push([Math.cos(a) * d, Math.sin(a) * d]);
  } else if (style === 'loop') {
    const a0 = angle(), d = r(), n = 4 + Math.floor(rand() * 3);
    for (let i = 1; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      waypoints.push([Math.cos(a) * d - Math.cos(a0) * d, Math.sin(a) * d - Math.sin(a0) * d]);
    }
  } else {
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = angle(), d = r();
      waypoints.push([Math.cos(a) * d, Math.sin(a) * d]);
    }
  }
  if (returnHome) waypoints.push([0, 0]);

  const flat = [];
  let cx = 0, cy = 0;
  for (const [wx, wy] of waypoints) {
    const tx = Math.round(wx) - cx, ty = Math.round(wy) - cy;
    flat.push(...segment(rand, tx, ty, bend(), dur()));
    cx += tx; cy += ty;
    if (rand() < 0.5) flat.push(...pause(40 + Math.floor(rand() * 220)));
  }
  return { style, flat };
}

// Next delay: interval +/- jitter, uniformly, never below a second.
function nextDelayMs(rand, intervalS, jitterS) {
  const s = intervalS + (rand() * 2 - 1) * jitterS;
  return Math.max(MIN_GAP_MS, Math.round(s * 1000));
}

const KINDS = {
  mouse_jiggle: {
    describe: (p) => `mouse gesture every ${p.interval_s}s +/- ${p.jitter_s}s`,
    defaults: { interval_s: 30, jitter_s: 10, radius_px: 40, return_home: true },
    async run(p, ctx) {
      const { style, flat } = jigglePath(ctx.rand, p.radius_px, p.return_home);
      await ctx.winhost.call('path', { flat }, { timeout: 10000 });
      return style;
    },
  },
  key_tap: {
    describe: (p) => `tap ${p.key} every ${p.interval_s}s +/- ${p.jitter_s}s`,
    defaults: { key: 'space', interval_s: 30, jitter_s: 10, hold_ms: 80 },
    async run(p, ctx) {
      const hold = Math.round(p.hold_ms * (0.7 + ctx.rand() * 0.6));
      await ctx.winhost.call('key_state', { key: p.key, up: false });
      await new Promise((r) => setTimeout(r, hold));
      await ctx.winhost.call('key_state', { key: p.key, up: true });
      return `${p.key} ${hold}ms`;
    },
  },
  remind: {
    describe: (p) => `say "${p.text}" every ${p.interval_s}s`,
    defaults: { text: 'Reminder.', interval_s: 600, jitter_s: 0 },
    async run(p, ctx) {
      ctx.say(p.text);
      return 'said';
    },
  },
};

function createRoutines({ winhost, say = () => {}, onChange = () => {}, rand = Math.random, timers = { setTimeout, clearTimeout }, now = Date.now } = {}) {
  const active = new Map();
  let nextId = 1;

  function snapshot() {
    return [...active.values()].map((r) => ({
      id: r.id, kind: r.kind, label: r.label, runs: r.runs,
      started: r.started, next_at: r.nextAt, last: r.last, ends_at: r.endsAt || null,
    }));
  }

  function schedule(r) {
    const delay = nextDelayMs(rand, r.params.interval_s, r.params.jitter_s);
    r.nextAt = now() + delay;
    r.timer = timers.setTimeout(() => tick(r), delay);
  }

  async function tick(r) {
    if (!active.has(r.id)) return;
    if (r.endsAt && now() >= r.endsAt) return stop(r.id);
    try {
      r.last = await KINDS[r.kind].run(r.params, { winhost, say, rand });
      r.runs++;
    } catch (err) {
      r.last = `error: ${err.message}`;
    }
    if (active.has(r.id)) schedule(r);
    onChange(snapshot());
  }

  function start(kind, params = {}) {
    const k = KINDS[kind];
    if (!k) throw new Error(`unknown routine: ${kind}. Known: ${Object.keys(KINDS).join(', ')}`);
    const p = { ...k.defaults };
    for (const [key, v] of Object.entries(params)) if (v !== undefined && v !== null) p[key] = v;
    const r = {
      id: String(nextId++), kind, params: p, label: k.describe(p),
      runs: 0, started: now(), last: null, timer: null,
      endsAt: p.duration_min ? now() + p.duration_min * 60000 : null,
    };
    active.set(r.id, r);
    schedule(r);
    onChange(snapshot());
    return { id: r.id, label: r.label, first_in_s: Math.round((r.nextAt - now()) / 1000) };
  }

  function stop(id) {
    const ids = id === 'all' || !id ? [...active.keys()] : [String(id)];
    const stopped = [];
    for (const i of ids) {
      const r = active.get(i);
      if (!r) continue;
      timers.clearTimeout(r.timer);
      active.delete(i);
      stopped.push(i);
    }
    onChange(snapshot());
    return { stopped };
  }

  return { start, stop, list: snapshot, kinds: Object.keys(KINDS) };
}

module.exports = { createRoutines, jigglePath, nextDelayMs, KINDS };
