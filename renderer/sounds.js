// Butler's chimes, synthesized so there are no audio files to ship. Quiet
// except the talk-key ping, which has to be heard over a game or music.
const Sounds = (() => {
  const ctx = new AudioContext();
  Devices.route(ctx);

  function tone(freq, start, dur, vol, type = 'sine') {
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // A bell: fundamental plus a soft inharmonic partial.
  function bell(freq, start, vol) {
    tone(freq, start, 0.9, vol);
    tone(freq * 2.76, start, 0.35, vol * 0.25);
  }

  const kinds = {
    wake: () => { tone(740, 0, 0.09, 0.05); tone(988, 0.07, 0.14, 0.05); },
    ptt: () => tone(1320, 0, 0.06, 0.14, 'triangle'),
    release: () => tone(990, 0, 0.04, 0.025, 'triangle'),
    needs: () => { bell(659, 0, 0.09); bell(988, 0.16, 0.08); },
    attention: () => { bell(784, 0, 0.07); bell(784, 0.14, 0.06); bell(1047, 0.28, 0.07); },
    done: () => bell(1047, 0, 0.045),
    error: () => { tone(392, 0, 0.18, 0.06, 'triangle'); tone(311, 0.14, 0.26, 0.06, 'triangle'); },
  };

  return {
    play(kind) {
      if (ctx.state === 'suspended') ctx.resume();
      (kinds[kind] || kinds.done)();
    },
  };
})();
