const test = require('node:test');
const assert = require('node:assert');
const { jigglePath, nextDelayMs, createRoutines } = require('../src/routines');

function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const net = (flat) => {
  let x = 0, y = 0, ms = 0;
  for (let i = 0; i < flat.length; i += 3) { x += flat[i]; y += flat[i + 1]; ms += flat[i + 2]; }
  return { x, y, ms };
};

test('jiggle paths return home exactly and take a human amount of time', () => {
  for (let seed = 1; seed < 200; seed++) {
    const { flat } = jigglePath(seeded(seed), 40, true);
    assert.equal(flat.length % 3, 0);
    const n = net(flat);
    assert.deepEqual([n.x, n.y], [0, 0], `seed ${seed} drifted`);
    assert.ok(n.ms > 150 && n.ms < 6000, `seed ${seed} took ${n.ms}ms`);
  }
});

test('jiggle paths differ from run to run', () => {
  const rand = seeded(7);
  const a = JSON.stringify(jigglePath(rand).flat);
  const b = JSON.stringify(jigglePath(rand).flat);
  assert.notEqual(a, b);
});

test('jiggle stays within a sane radius', () => {
  for (let seed = 1; seed < 100; seed++) {
    const { flat } = jigglePath(seeded(seed), 40, true);
    let x = 0, y = 0, max = 0;
    for (let i = 0; i < flat.length; i += 3) { x += flat[i]; y += flat[i + 1]; max = Math.max(max, Math.hypot(x, y)); }
    assert.ok(max < 120, `seed ${seed} wandered ${max}px`);
  }
});

test('delay is interval +/- jitter', () => {
  const rand = seeded(3);
  for (let i = 0; i < 500; i++) {
    const d = nextDelayMs(rand, 30, 10);
    assert.ok(d >= 20000 && d <= 40000, `${d}`);
  }
  assert.equal(nextDelayMs(() => 0, 0, 0), 1000, 'never below a second');
});

test('routine runs on schedule and stops cleanly', async () => {
  const calls = [];
  const timers = [];
  const fakeTimers = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  const winhost = { call: async (op, args) => { calls.push({ op, args }); } };
  const r = createRoutines({ winhost, rand: seeded(1), timers: fakeTimers });
  const started = r.start('mouse_jiggle', { interval_s: 30, jitter_s: 10 });
  assert.ok(started.first_in_s >= 20 && started.first_in_s <= 40);
  await timers[0].fn();
  assert.equal(calls[0].op, 'path');
  assert.equal(r.list()[0].runs, 1);
  assert.equal(timers.length, 2, 'rescheduled after a run');
  r.stop('all');
  assert.equal(r.list().length, 0);
  assert.equal(timers[1].fn, null, 'pending timer cleared');
});

test('unknown routine kind is refused', () => {
  const r = createRoutines({ winhost: { call: async () => {} } });
  assert.throws(() => r.start('dance'), /unknown routine/);
});
