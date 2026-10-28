// GPT-Live (voice.engine "live"): one full-duplex session hears Josh and
// speaks, and hands anything that needs Butler's tools to the delegate lane
// in main. Same surface as TurnVoice, so dock.js drives either one:
//   Pause held:   the mic opens into the session (opened on demand); let go
//                 and the model hears silence and answers
//   Pause tapped: the press's audio is dropped
//   Wake word:    the mic stays open until the conversation goes quiet
// A session bills every second it is open, so it closes after
// voice.live.idleSeconds of quiet; the next press opens a fresh one seeded
// with the current chat.
const LiveVoice = (() => {
  const audioEl = new Audio();
  audioEl.autoplay = true;
  Devices.route(audioEl);
  const SPEECH_RMS = 0.004;
  const SPEECH_END_MS = 700;
  const REPLY_WAIT_MS = 8000;

  let cfg = null;
  let hooks = {};
  let pc = null, dc = null, opening = null, live = false, onStarted = null, closeTimer = null;
  let mode = 'idle'; // idle | ptt | convo
  let held = false;  // the press is a confirmed hold, so its audio may flow
  let openedFor = 0; // the press that opened this session, until it is used
  let presses = 0;
  let speaking = false, quietSince = 0;
  let delegations = 0;
  let lastActivity = 0;
  let turn = null;   // { id, heard, said, shown }
  let lastHeard = '';
  let seq = 0, events = 0;
  let replyTimer = null;
  let analyser = null;
  const says = [];

  const emit = (name, ...a) => { if (hooks[name]) hooks[name](...a); };
  const log = (m) => window.butler.log(`live: ${m}`);
  const touch = () => { lastActivity = Date.now(); };
  const send = (msg) => { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ event_id: `b${++events}`, ...msg })); };
  const append = (type, content, delegationId = null) => send({ type, delegation_id: delegationId, content: content.slice(0, 1800) });

  // ── the session ─────────────────────────────────────────────────────────
  function iceGathered(peer) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); });
      setTimeout(resolve, 2000);
    });
  }

  function connect() {
    if (live) return Promise.resolve();
    if (opening) return opening;
    opening = (async () => {
      const t0 = performance.now();
      pc = new RTCPeerConnection();
      pc.addTrack(Mic.sendTrack());
      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        audioEl.srcObject = stream;
        watchOutput(stream);
        emit('onRemoteStream', stream);
      };
      pc.onconnectionstatechange = () => {
        if (pc && ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop(`connection ${pc.connectionState}`);
      };
      dc = pc.createDataChannel('oai-events');
      dc.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { log(`event: ${err.message}`); } };
      const started = new Promise((resolve, reject) => {
        onStarted = resolve;
        setTimeout(() => reject(new Error('GPT-Live did not start')), 10000);
      });
      started.catch(() => {});
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc);
      const { sdp } = await window.butler.liveSession(pc.localDescription.sdp);
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await started;
      live = true;
      touch();
      log(`session up in ${Math.round(performance.now() - t0)}ms`);
      flow();
    })();
    const p = opening;
    p.catch((err) => drop(err.message)).finally(() => { if (opening === p) opening = null; });
    return p;
  }

  // Graceful close: session.closed carries the final usage.
  function close() {
    if (!live) return;
    live = false;
    send({ type: 'session.close' });
    closeTimer = setTimeout(() => drop('close timed out'), 5000);
  }

  function drop(reason) {
    if (!pc) return;
    clearTimeout(closeTimer);
    live = false;
    speaking = false;
    Mic.sendFlow(false);
    try { dc.close(); } catch { /* closed */ }
    try { pc.close(); } catch { /* closed */ }
    pc = dc = null;
    audioEl.srcObject = null;
    if (reason !== 'closed') log(`dropped: ${reason}`);
    if (turn) finishTurn();
    if (mode !== 'idle') { mode = 'idle'; Mic.sendOpen(false); emit('onIdle'); }
  }

  // Audio flows only once the session listens and the press is a real hold.
  function flow() {
    Mic.sendFlow(live && (mode === 'convo' || held));
  }

  // ── speech out ──────────────────────────────────────────────────────────
  // GPT-Live marks no end of a spoken answer, so the output level decides.
  function watchOutput(stream) {
    if (!analyser) {
      const ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      watchOutput.ctx = ctx;
    }
    watchOutput.ctx.createMediaStreamSource(stream).connect(analyser);
  }

  function outputLevel() {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.sqrt(s / buf.length);
  }

  function watchSpeech() {
    if (!analyser || !pc) return;
    const now = Date.now();
    if (outputLevel() > SPEECH_RMS) {
      quietSince = 0;
      if (speaking) return;
      speaking = true;
      touch();
      clearTimeout(replyTimer);
      if (!turn) beginTurn();
      if (turn.heard.trim()) emit('onUserText', turn.heard.trim());
      emit('onSpeaking');
    } else if (speaking) {
      if (!quietSince) quietSince = now;
      if (now - quietSince < SPEECH_END_MS) return;
      speaking = false;
      touch();
      // Still working on a delegated request: back to thinking until its result is spoken.
      if (delegations) emit('onThinking');
      else finishTurn();
    }
  }

  // ── turns ───────────────────────────────────────────────────────────────
  function beginTurn() {
    turn = { id: ++seq, heard: '', said: '', shown: '' };
  }

  function finishTurn() {
    const t = turn;
    turn = null;
    clearTimeout(replyTimer);
    if (!t) return;
    const heard = t.heard.trim(), said = t.said.trim();
    if (heard) lastHeard = heard;
    if (heard) emit('onUserText', heard);
    if (said) {
      emit('onButlerText', said);
      if (heard) window.butler.liveRecord({ heard, answer: said, shown: t.shown });
    } else emit('onResponseDone');
    emit('onSpeakingDone');
    flushSays();
  }

  // A turn the model never answers ends on its own.
  function waitForReply() {
    clearTimeout(replyTimer);
    replyTimer = setTimeout(() => { if (!speaking && !delegations) finishTurn(); }, REPLY_WAIT_MS);
  }

  // The delegation event carries no words, so the request is what Josh said this turn.
  async function delegate(id) {
    delegations++;
    touch();
    clearTimeout(replyTimer);
    if (!turn) beginTurn();
    const t = turn;
    emit('onTool', 'delegate');
    let result;
    try {
      const r = await window.butler.liveDelegate(t.heard.trim() || lastHeard);
      if (r.dock) t.shown = r.dock;
      result = r.answer || 'Done, nothing to report.';
    } catch (err) {
      result = `That failed: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    }
    delegations--;
    touch();
    if (!live) return;
    append('session.commentary.append', result, id);
    waitForReply();
  }

  function handle(ev) {
    switch (ev.type) {
      case 'session.started':
        if (onStarted) onStarted();
        break;
      case 'session.input_transcript.delta':
        touch();
        if (!turn) {
          if (mode !== 'convo') break;
          beginTurn();
          emit('onListening', 'convo');
        }
        turn.heard += ev.delta || '';
        break;
      case 'session.output_transcript.delta':
        touch();
        if (!turn) beginTurn();
        turn.said += ev.delta || '';
        emit('onButlerDelta', ev.delta || '', turn.id);
        break;
      case 'session.delegation.created':
        delegate(ev.delegation.id);
        break;
      case 'session.closed':
        log(`closed (${ev.reason}), ${ev.usage && ev.usage.seconds}s billed`);
        drop('closed');
        break;
      case 'error': {
        const e = ev.error || {};
        log(`error ${e.code}: ${String(e.message || '').slice(0, 200)}`);
        if (!e.client_event_id && turn && !turn.said) emit('onError', e.message || 'voice error');
        break;
      }
      default:
        break;
    }
  }

  // ── Pause, the wake word, typed text ────────────────────────────────────
  function pttDown() {
    touch();
    if (turn && !speaking && !delegations) finishTurn();
    mode = 'ptt';
    held = false;
    flow();
    Mic.sendDrop();
    Mic.sendOpen(true);
    emit('onListening', 'ptt');
    const press = ++presses;
    if (!live && !opening) openedFor = press;
    connect().catch((err) => emit('onError', err.message));
  }

  // The dock calls this once the press is a confirmed hold. The old answer is
  // silenced here; the model hears Josh over it and stops on its own.
  function interrupt() {
    if (mode !== 'ptt') return;
    audioEl.muted = true;
    held = true;
    openedFor = 0;
    if (turn) finishTurn();
    beginTurn();
    flow();
  }

  function pttUp(kind = 'hold') {
    if (mode !== 'ptt') return;
    mode = 'idle';
    Mic.sendOpen(false);
    audioEl.muted = false;
    if (kind === 'tap' || !held) {
      Mic.sendDrop();
      flow();
      // A tap that opened a session has nothing to say in it.
      if (openedFor === presses) {
        const press = presses;
        openedFor = 0;
        connect().then(() => { if (presses === press && mode === 'idle' && !turn) close(); }, () => {});
      }
      emit('onIdle');
      return;
    }
    held = false;
    emit('onThinking');
    waitForReply();
  }

  async function startConversation(words) {
    touch();
    if (turn && !speaking && !delegations) finishTurn();
    mode = 'convo';
    Mic.sendDrop();
    Mic.sendOpen(true);
    emit('onListening', 'convo');
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    flow();
    if (words) {
      beginTurn();
      turn.heard = words;
      append('session.instructions.append', `Josh just said: "${words}" Respond to it now.`);
      waitForReply();
    }
  }

  function endConversation() {
    if (mode !== 'convo') return;
    mode = 'idle';
    Mic.sendOpen(false);
    flow();
    emit('onIdle');
  }

  async function sendText(text) {
    touch();
    if (turn && !speaking && !delegations) finishTurn();
    beginTurn();
    turn.heard = text;
    emit('onThinking');
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    append('session.instructions.append', `Josh typed this to you: "${text}" Respond to it now.`);
    waitForReply();
  }

  // Background news, such as an agent finishing. Waits for a quiet moment.
  function say(text) {
    says.push(text);
    flushSays();
  }

  async function flushSays() {
    if (!says.length || speaking || turn || delegations || mode !== 'idle') return;
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    if (turn || speaking) return;
    beginTurn();
    append('session.instructions.append', `${says.shift()} Say it now.`);
    waitForReply();
  }

  // ── upkeep ──────────────────────────────────────────────────────────────
  function upkeep() {
    const quietMs = Date.now() - lastActivity;
    if (mode === 'convo' && !speaking && !delegations && quietMs > (cfg.voice.conversationIdleSeconds || 12) * 1000) endConversation();
    if (live && mode === 'idle' && !speaking && !delegations && !turn && !says.length && quietMs > cfg.voice.live.idleSeconds * 1000) close();
  }

  async function init(c, micTrack, h) {
    cfg = c;
    hooks = h || {};
    window.butler.onVoiceEvent((e) => (e.type === 'tool' ? emit('onTool', e.name) : emit('onToolDone', e.name, e.out)));
    setInterval(watchSpeech, 50);
    setInterval(upkeep, 1000);
    emit('onConnected');
  }

  return {
    init, pttDown, pttUp, startConversation, endConversation, sendText, say, interrupt,
    mode: () => mode, isConnected: () => live,
  };
})();
