// OpenAI Realtime over WebRTC, kept warm so Pause answers instantly.
// Resting state: connected, no mic track attached, turn detection off.
//   Pause held:   mic attached, released -> commit + respond (push-to-talk)
//   Pause tapped: turn dropped (the tap opens or closes the dock)
//   stop:         a press while Butler speaks cuts the answer off
//   Wake word:    conversation mode with server VAD until Josh goes quiet
// Only the newest press may make Butler speak: a press or stop bumps epoch,
// and tool results from an older one are filed without a spoken follow-up.
const RealtimeVoice = (() => {
  const audioEl = new Audio();
  audioEl.autoplay = true;
  Devices.route(audioEl);

  let cfg = null;
  let hooks = {};
  let pc = null, dc = null, sender = null;
  let micTrack = null;
  let connected = false, connecting = null;
  let mode = 'idle'; // idle | ptt | convo
  let responseActive = false, speaking = false, toolsInFlight = 0;
  let outbox = [];
  let says = [];
  let pttHeld = false;
  let pendingKind = 'hold';
  let convoTimer = null;
  let connectedAt = 0, lastActivity = 0, usedSinceConnect = false;
  let epoch = 0;
  let turn = null; // { heard, said, done } for the chat list

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const emit = (name, ...a) => { if (hooks[name]) hooks[name](...a); };

  function send(msg) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
    else outbox.push(msg);
  }

  function touch() { lastActivity = Date.now(); usedSinceConnect = true; }

  async function connect() {
    if (connected) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const { clientSecret } = await window.butler.mint();
      pc = new RTCPeerConnection();
      sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        audioEl.srcObject = stream;
        emit('onRemoteStream', stream);
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc && pc.connectionState)) drop('connection ' + (pc && pc.connectionState));
      };
      dc = pc.createDataChannel('oai-events');
      dc.onopen = () => { for (const m of outbox.splice(0)) dc.send(JSON.stringify(m)); };
      dc.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { window.butler.log('voice event: ' + err.message); } };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`realtime sdp ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      connected = true;
      connectedAt = Date.now();
      usedSinceConnect = false;
      emit('onConnected');
      flushSays();
    })();
    try { await connecting; } catch (err) { drop(err.message); throw err; } finally { connecting = null; }
  }

  function drop(reason) {
    const was = connected;
    connected = false;
    responseActive = false;
    speaking = false;
    if (dc) try { dc.close(); } catch { /* closed */ }
    if (pc) try { pc.close(); } catch { /* closed */ }
    dc = pc = sender = null;
    outbox = [];
    if (was) emit('onDisconnected', reason);
  }

  // ── turn control ─────────────────────────────────────────────────────────
  function interrupt() {
    if (responseActive) send({ type: 'response.cancel' });
    if (speaking) send({ type: 'output_audio_buffer.clear' });
  }

  function stop() {
    epoch++;
    says.length = 0;
    turn = null;
    interrupt();
  }

  function setTurnDetection(on) {
    const td = on ? {
      type: 'server_vad',
      threshold: cfg.voice.vad.threshold,
      prefix_padding_ms: 300,
      silence_duration_ms: cfg.voice.vad.silenceMs,
      create_response: true,
      interrupt_response: true,
    } : null;
    send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: td } } } });
  }

  // Refresh the live context (focused window, agents, routines) for this turn.
  async function refreshInstructions() {
    try {
      const instructions = await window.butler.instructions();
      send({ type: 'session.update', session: { type: 'realtime', instructions } });
    } catch (err) { window.butler.log('instructions: ' + err.message); }
  }

  async function pttDown() {
    pttHeld = true;
    epoch++;
    turn = null;
    touch();
    clearTimeout(convoTimer);
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    interrupt();
    mode = 'ptt';
    setTurnDetection(false);
    send({ type: 'input_audio_buffer.clear' });
    await sender.replaceTrack(micTrack);
    emit('onListening', 'ptt');
    refreshInstructions();
    // Released while we were still connecting: finish the turn now.
    if (!pttHeld) await pttUp(pendingKind);
  }

  // kind: 'hold' commits the turn; 'tap' drops it, since a tap is not a question.
  async function pttUp(kind = 'hold') {
    pttHeld = false;
    pendingKind = kind;
    if (mode !== 'ptt') return; // pttDown is still connecting and will call back
    if (kind === 'tap') {
      if (sender) await sender.replaceTrack(null);
      send({ type: 'input_audio_buffer.clear' });
      mode = 'idle';
      emit('onIdle');
      return;
    }
    // Let the last syllable's packets reach the server before the commit does.
    await sleep(cfg.voice.pttTailMs || 200);
    if (sender) await sender.replaceTrack(null);
    send({ type: 'input_audio_buffer.commit' });
    send({ type: 'response.create' });
    turn = { heard: '', said: '', done: false };
    mode = 'idle';
    emit('onThinking');
  }

  async function startConversation(opening) {
    touch();
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    interrupt();
    mode = 'convo';
    setTurnDetection(true);
    send({ type: 'input_audio_buffer.clear' });
    await sender.replaceTrack(micTrack);
    refreshInstructions();
    emit('onListening', 'convo');
    if (opening) sendText(opening);
    armConvoIdle();
  }

  async function endConversation() {
    clearTimeout(convoTimer);
    if (mode !== 'convo') return;
    mode = 'idle';
    if (sender) await sender.replaceTrack(null);
    setTurnDetection(false);
    emit('onIdle');
  }

  function armConvoIdle() {
    clearTimeout(convoTimer);
    if (mode !== 'convo') return;
    convoTimer = setTimeout(() => {
      if (responseActive || speaking) return armConvoIdle();
      endConversation();
    }, (cfg.voice.conversationIdleSeconds || 12) * 1000);
  }

  // Typed text from the dock, or the words that followed "Butler" in one breath.
  async function sendText(text) {
    touch();
    try { await connect(); } catch (err) { emit('onError', err.message); return; }
    interrupt();
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    send({ type: 'response.create' });
    emit('onUserText', text);
  }

  // Background news (agent finished, task question). Waits for a quiet moment.
  function say(text) {
    says.push(text);
    if (!connected) connect().catch((err) => emit('onError', err.message));
    else flushSays();
  }

  function flushSays() {
    if (!connected || responseActive || speaking || toolsInFlight || mode === 'ptt' || !says.length) return;
    const text = says.shift();
    touch();
    send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    send({ type: 'response.create' });
  }

  // ── server events ────────────────────────────────────────────────────────
  // One exchange per press goes to the chat list once both sides are known.
  function record() {
    if (!turn || !turn.done || !turn.heard || !turn.said.trim()) return;
    window.butler.liveRecord({ heard: turn.heard, answer: turn.said.trim(), shown: '' });
    turn = null;
  }

  async function runTools(calls) {
    const mine = epoch;
    toolsInFlight++;
    const results = await Promise.all(calls.map(async (c) => {
      emit('onTool', c.name, c.arguments);
      let out;
      try { out = await window.butler.tool(c.name, c.arguments ? JSON.parse(c.arguments) : {}); } catch (err) { out = { error: err.message }; }
      emit('onToolDone', c.name, out);
      return { c, out };
    }));
    const images = [];
    for (const { c, out } of results) {
      // A screenshot from look travels as an image message, never inside the JSON.
      if (out && out.attach_image) { images.push(out.attach_image); delete out.attach_image; }
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(out).slice(0, 12000) } });
    }
    for (const url of images) {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url, detail: 'high' }] } });
    }
    // end_conversation needs no spoken follow-up beyond what was already said.
    toolsInFlight--;
    if (mine === epoch && !calls.every((c) => c.name === 'end_conversation')) send({ type: 'response.create' });
    else flushSays();
  }

  function handle(ev) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        touch();
        emit('onListening', mode);
        armConvoIdle();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript && ev.transcript.trim()) {
          emit('onUserText', ev.transcript.trim());
          if (turn) { turn.heard = ev.transcript.trim(); record(); }
        }
        break;
      case 'response.created':
        responseActive = true;
        emit('onThinking');
        break;
      case 'output_audio_buffer.started':
        speaking = true;
        emit('onSpeaking');
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        speaking = false;
        emit('onSpeakingDone');
        armConvoIdle();
        flushSays();
        break;
      case 'response.output_audio_transcript.delta':
        if (ev.delta) emit('onButlerDelta', ev.delta, ev.response_id);
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript) {
          emit('onButlerText', ev.transcript);
          if (turn) turn.said += ` ${ev.transcript}`;
        }
        break;
      case 'response.done': {
        responseActive = false;
        touch();
        const cut = ev.response && ev.response.status === 'cancelled';
        const calls = cut ? [] : ((ev.response && ev.response.output) || []).filter((o) => o.type === 'function_call');
        if (calls.length) runTools(calls);
        else {
          emit('onResponseDone');
          if (turn && !cut) { turn.done = true; record(); }
        }
        armConvoIdle();
        flushSays();
        break;
      }
      case 'error': {
        const code = ev.error && ev.error.code;
        if (code === 'response_cancel_not_active' || code === 'input_audio_buffer_commit_empty') break;
        window.butler.log('realtime error ' + JSON.stringify(ev.error || ev).slice(0, 300));
        emit('onError', (ev.error && ev.error.message) || 'voice error');
        break;
      }
      default:
        break;
    }
  }

  // Idle upkeep: a fresh session after a quiet spell keeps the context (and
  // cost) small, and a periodic reconnect stays under the session time limit.
  function upkeep() {
    if (!connected || mode !== 'idle' || responseActive || toolsInFlight || speaking || says.length) return;
    const quietMin = (Date.now() - lastActivity) / 60000;
    const ageMin = (Date.now() - connectedAt) / 60000;
    if ((usedSinceConnect && quietMin > cfg.voice.freshContextAfterMinutes) || ageMin > cfg.voice.reconnectAfterMinutes) {
      drop('refresh');
      connect().catch((err) => emit('onError', err.message));
    }
  }

  async function init(config, track, h) {
    cfg = config;
    micTrack = track;
    hooks = h || {};
    setInterval(upkeep, 30000);
    await connect();
  }

  return {
    init, pttDown, pttUp, startConversation, endConversation, sendText, say, interrupt, stop,
    mode: () => mode, isConnected: () => connected,
  };
})();
