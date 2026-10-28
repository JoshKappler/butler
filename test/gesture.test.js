const test = require('node:test');
const assert = require('node:assert');
const { createGesture } = require('../src/gesture');

function rig() {
  let t = 0;
  let pending = null;
  const events = [];
  const g = createGesture({
    now: () => t,
    onHoldStart: () => events.push('start'),
    onHoldConfirmed: () => events.push('confirmed'),
    onHoldEnd: () => events.push('hold'),
    onTap: () => events.push('tap'),
    setTimer: (fn, ms) => { pending = { fn, due: t + ms }; return pending; },
    clearTimer: (p) => { if (pending === p) pending = null; },
  });
  // Moving the clock fires the threshold timer if it came due.
  const at = (ms) => { t = ms; if (pending && pending.due <= t) { const p = pending; pending = null; p.fn(); } };
  return { g, events, at };
}

test('holding talks', () => {
  const { g, events, at } = rig();
  at(0); g.down(); at(900); g.up();
  assert.deepEqual(events, ['start', 'confirmed', 'hold']);
});

test('every quick press is its own tap, however close together', () => {
  const { g, events, at } = rig();
  at(0); g.down(); at(80); g.up();
  at(150); g.down(); at(220); g.up();
  assert.deepEqual(events, ['start', 'tap', 'start', 'tap']);
});

test('key repeat is ignored', () => {
  const { g, events, at } = rig();
  at(0); g.down(); g.down(); g.down(); at(90); g.up();
  assert.deepEqual(events, ['start', 'tap']);
});

test('the tap and hold boundary is the tap threshold, and a tap is never confirmed as a hold', () => {
  const { g, events, at } = rig();
  at(0); g.down(); at(349); g.up();
  at(1000); g.down(); at(1350); g.up();
  assert.deepEqual(events, ['start', 'tap', 'start', 'confirmed', 'hold']);
});
