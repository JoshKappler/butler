// Turn-based voice (voice.engine "turns"), for any model lane. Same surface as
// RealtimeVoice in voice.js, so dock.js drives either one:
//   Pause held:   record; released -> the voice lane answers, main speaks it
//   Pause tapped: recording dropped
//   Pause pressed while speaking: the dock calls stop, and the answer ends
//   Conversation: record until a pause in speech, answer, listen again
const TurnVoice = (() => {
  const player = new Audio();
  Devices.route(player);
  let cfg = null;
  let hooks = {};
  let mode = 'idle'; // idle | ptt | convo
  let seq = 0;       // bumped by every new turn and interrupt; stale replies are dropped
  let speaking = false;
  let vad = null;
  let playUrl = null;

  const emit = (name, ...args) => { if (hooks[name]) hooks[name](...args); };

  function pcm(frames) {
    const n = frames.reduce((s, f) => s + f.byteLength, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const f of frames) { out.set(new Uint8Array(f), at); at += f.byteLength; }
    return out.buffer;
  }

  function stopPlayback() {
    player.pause();
    if (speaking) { speaking = false; emit('onSpeakingDone'); }
  }

  function interrupt() {
    seq++;
    stopPlayback();
  }

  async function speak(text, id) {
    const out = await window.butler.speak(text);
    if (id !== seq) return;
    if (playUrl) URL.revokeObjectURL(playUrl);
    playUrl = URL.createObjectURL(new Blob([out.audio], { type: out.mime }));
    player.src = playUrl;
    await player.play();
    speaking = true;
    emit('onRemoteStream', player.captureStream());
    emit('onSpeaking');
  }

  async function turn(payload) {
    const id = ++seq;
    stopVad();
    Mic.stopRecording();
    emit('onThinking');
    try {
      const r = await window.butler.voiceTurn(payload);
      if (id !== seq) return;
      if (!r.answer) { emit('onResponseDone'); return listenAgain(); }
      if (r.heard && !payload.text) emit('onUserText', r.heard);
      emit('onButlerDelta', r.answer, id);
      emit('onButlerText', r.answer);
      // Done only once speech starts, so the dock stays up while it is synthesized.
      await speak(r.answer, id);
      emit('onResponseDone');
    } catch (err) {
      if (id === seq) { emit('onError', String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); listenAgain(); }
    }
  }

  function recorded() {
    const frames = Mic.stopRecording();
    const bytes = frames.reduce((s, f) => s + f.byteLength, 0);
    return bytes >= Mic.rate * 2 * 0.3 ? { pcm: pcm(frames), rate: Mic.rate } : null;
  }

  // A press leaves a reply that is still thinking alone, so a tap to open or
  // close the dock never eats it; a confirmed hold cancels it.
  function pttDown() {
    stopVad();
    mode = 'ptt';
    Mic.startRecording();
    emit('onListening', 'ptt');
  }

  function pttUp(kind = 'hold') {
    if (mode !== 'ptt') return;
    mode = 'idle';
    const clip = recorded();
    if (kind === 'tap' || !clip) { emit('onIdle'); return; }
    turn(clip);
  }

  // Conversation mode: a level gate stands in for server VAD. Speech opens a
  // take; silenceMs of quiet after it closes the take and sends it.
  function stopVad() {
    if (vad) { clearInterval(vad.timer); vad = null; }
  }

  function listen() {
    stopVad();
    Mic.startRecording();
    emit('onListening', 'convo');
    const gate = cfg.wake.speechGateRms || 0.012;
    const silence = (cfg.voice.vad && cfg.voice.vad.silenceMs) || 450;
    const idle = (cfg.voice.conversationIdleSeconds || 12) * 1000;
    const started = Date.now();
    let heardAt = 0;
    vad = { timer: setInterval(() => {
      if (Mic.level() > gate) heardAt = Date.now();
      if (!heardAt && Date.now() - started > idle) return endConversation();
      if (heardAt && Date.now() - heardAt > silence) {
        stopVad();
        const clip = recorded();
        if (clip) turn(clip); else listen();
      }
    }, 50) };
  }

  function listenAgain() {
    if (mode === 'convo' && !speaking) listen();
  }

  player.onended = () => {
    speaking = false;
    emit('onSpeakingDone');
    listenAgain();
  };

  function startConversation(opening) {
    interrupt();
    mode = 'convo';
    if (opening) turn({ text: opening });
    else listen();
  }

  function endConversation() {
    if (mode !== 'convo') return;
    mode = 'idle';
    stopVad();
    Mic.stopRecording();
    emit('onIdle');
  }

  async function init(c, micTrack, h) {
    cfg = c;
    hooks = h;
    window.butler.onVoiceEvent((e) => (e.type === 'tool' ? emit('onTool', e.name) : emit('onToolDone', e.name, e.out)));
    emit('onConnected');
  }

  return {
    init, pttDown, pttUp, startConversation, endConversation, interrupt, stop: interrupt,
    sendText: (text) => turn({ text }),
    say: (text) => speak(text, seq).catch((err) => emit('onError', err.message)),
    mode: () => mode,
  };
})();
