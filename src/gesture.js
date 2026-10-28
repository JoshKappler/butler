// Pause does two things. From raw key down/up events this tells apart:
//   hold  -> talk (push-to-talk), ends on release
//   tap   -> open or close the dock
// onHoldConfirmed fires once a press outlasts the tap threshold, so a tap
// never flashes the hold's view first.
// Pure and clock-injected so it can be tested without a keyboard.
function createGesture({ tapMs = 350, onHoldStart, onHoldConfirmed = () => {}, onHoldEnd, onTap, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let downAt = 0;
  let down = false;
  let timer = null;

  return {
    down() {
      if (down) return; // typematic repeat
      down = true;
      downAt = now();
      onHoldStart();
      timer = setTimer(() => { if (down) onHoldConfirmed(); }, tapMs);
    },
    up() {
      if (!down) return;
      down = false;
      clearTimer(timer);
      const held = now() - downAt;
      return held >= tapMs ? onHoldEnd({ held }) : onTap({ held });
    },
    isDown: () => down,
  };
}

module.exports = { createGesture };
