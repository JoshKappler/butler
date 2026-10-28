// One microphone for everything. Its track feeds the Realtime session during
// a turn. A 24kHz PCM16 tap feeds either the live captions (every frame, while
// Josh talks) or, between turns, the wake watcher, gated by level so a quiet
// room sends nothing. The turn-based voice records the same tap.
// GPT-Live gets its own track: while open, frames queue from the first
// syllable; while flowing, they play into the track, skipping quiet frames to
// catch up on audio queued while the session connected. Otherwise the track
// carries silence, which the live model reads as Josh being done.
const Mic = (() => {
  const RATE = 24000;
  const CATCH_UP_RMS = 0.003; // a quiet room measures about 0.001
  let feed = null; // null | 'wake' | 'captions'
  let level = 0;
  let recording = null; // PCM16 frames while a turn records
  const live = { queue: [], open: false, flow: false, track: null };

  function rms(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / f32.length);
  }

  function toPCM16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  async function init(cfg) {
    // Chromium's gain control moves the Windows mic volume, and the mic watchdog moves it back.
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
    const id = await Devices.inputId(cfg.audio.input);
    if (cfg.audio.input && !id) window.butler.log(`input device not found: ${cfg.audio.input}`);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { ...audio, deviceId: { exact: id } } : audio });
    const ctx = new AudioContext({ sampleRate: RATE });
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1); // ~85ms frames
    const gate = cfg.wake.speechGateRms || 0.012;
    const preroll = [];
    let open = false;
    let quiet = 0;
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      const r = rms(data);
      level = level * 0.55 + r * 0.45;
      if (recording) recording.push(toPCM16(data));
      if (live.open && live.queue.length < 120) live.queue.push(Float32Array.from(data));
      if (feed === 'captions') return window.butler.captionAudio(toPCM16(data));
      if (feed !== 'wake' || cfg.wake.engine !== 'openai') return;
      const pcm = toPCM16(data);
      if (r > gate) {
        if (!open) for (const p of preroll.splice(0)) window.butler.wakeAudio(p);
        open = true;
        quiet = 0;
        window.butler.wakeAudio(pcm);
      } else if (open) {
        window.butler.wakeAudio(pcm);
        // ~1s of trailing silence lets the server VAD close the utterance.
        if (++quiet > 12) open = false;
      } else {
        preroll.push(pcm);
        if (preroll.length > 6) preroll.shift();
      }
    };
    src.connect(node);
    node.connect(ctx.destination);

    const sender = ctx.createScriptProcessor(2048, 1, 1);
    const dest = ctx.createMediaStreamDestination();
    sender.onaudioprocess = (e) => {
      const o = e.outputBuffer.getChannelData(0);
      while (live.flow && live.queue.length > 1 && rms(live.queue[0]) < CATCH_UP_RMS) live.queue.shift();
      const f = live.flow && live.queue.shift();
      if (f) o.set(f); else o.fill(0);
    };
    src.connect(sender); // a script processor runs only while it has an input
    sender.connect(dest);
    live.track = dest.stream.getAudioTracks()[0];
    return stream.getAudioTracks()[0];
  }

  return {
    init,
    setFeed: (target) => { feed = target; },
    feed: () => feed,
    level: () => level,
    rate: RATE,
    startRecording: () => { recording = []; },
    stopRecording: () => { const r = recording || []; recording = null; return r; },
    sendTrack: () => live.track,
    sendOpen: (on) => { live.open = on; },
    sendFlow: (on) => { live.flow = on; },
    sendDrop: () => { live.queue = []; },
  };
})();
