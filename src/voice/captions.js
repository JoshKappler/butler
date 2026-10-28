// Live captions: what Butler is hearing, word by word, while Josh talks, so a
// misheard command is caught before it runs. One streaming session per turn.
//   muse:   Meta Muse Voice Transcribe, partials every 80ms (needs META_API_KEY)
//   openai: gpt-live-transcribe transcription session, streamed deltas
//   auto:   muse when META_API_KEY is set, else openai
const WebSocket = require('ws');

const MUSE_URL = 'wss://api.meta.ai/v1/asr/realtime';
const OPENAI_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

function pickEngine(config, env = process.env) {
  const e = (config.captions && config.captions.engine) || 'auto';
  if (e !== 'auto') return e;
  if (env.META_API_KEY) return 'muse';
  return env.OPENAI_API_KEY ? 'openai' : 'off';
}

// Keeps per-segment text in arrival order; a later event for a segment
// replaces its text. Joined, it is the caption so far.
function createTranscript() {
  const order = [];
  const text = new Map();
  return {
    set(id, t) { if (!text.has(id)) order.push(id); text.set(id, t); },
    append(id, d) { if (!text.has(id)) order.push(id); text.set(id, (text.get(id) || '') + d); },
    value: () => order.map((id) => text.get(id)).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

function museSession({ key, config, mode, emit, log }) {
  const ws = new WebSocket(config.captions.museUrl || MUSE_URL);
  const queue = [];
  let ready = false;
  const tr = createTranscript();
  let seg = 0;
  ws.on('open', () => ws.send(JSON.stringify({
    // The key rides in the first frame: Meta's socket takes no auth header.
    authorization: { accessToken: key },
    model: config.captions.museModel || 'muse-voice-transcribe-1.0',
    mode: mode === 'convo' ? 'ENDPOINTING' : 'PUSH_TO_TALK',
    audioEncoding: 'PCM_24KHZ',
    partialMode: 'CUMULATIVE',
    keywords: config.captions.keywords || [],
    languageBias: ['English'],
  })));
  ws.on('message', (data, binary) => {
    if (binary) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.sessionId && !ready) {
      ready = true;
      for (const b of queue.splice(0)) ws.send(b);
      return;
    }
    if (m.type === 'transcript' && typeof m.transcript === 'string') {
      tr.set(seg, m.transcript);
      emit({ text: tr.value(), final: !!m.final });
    } else if (m.type === 'speechComplete') {
      tr.set(seg++, m.transcript || '');
      emit({ text: tr.value(), final: mode !== 'convo', segmentDone: true });
    } else if (m.type === 'error') {
      log(`captions muse: ${m.message}`);
    }
  });
  ws.on('error', (err) => log(`captions muse ws: ${err.message}`));
  return {
    audio(buf) {
      const b = Buffer.from(buf);
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(b);
      else if (queue.length < 80) queue.push(b); // ~7s of pre-connect audio
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endStream' }));
      else ws.terminate();
      setTimeout(() => { try { ws.close(); } catch { /* closed */ } }, 2500);
    },
  };
}

function openaiSession({ key, config, emit, log }) {
  const ws = new WebSocket(config.captions.openaiUrl || OPENAI_URL, { headers: { Authorization: `Bearer ${key}` } });
  const queue = [];
  let ready = false;
  const tr = createTranscript();
  const model = config.captions.openaiModel || 'gpt-live-transcribe';
  const transcription = { model, language: 'en' };
  if (/^gpt-live-transcribe/.test(model)) transcription.keywords = config.captions.keywords || [];
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'near_field' },
            transcription,
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 900 },
          },
        },
      },
    }));
    ready = true;
    for (const b of queue.splice(0)) ws.send(b);
  });
  const frame = (buf) => JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(buf).toString('base64') });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'conversation.item.input_audio_transcription.delta') {
      tr.append(m.item_id, m.delta || '');
      emit({ text: tr.value(), final: false });
    } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
      tr.set(m.item_id, m.transcript || '');
      emit({ text: tr.value(), final: false, segmentDone: true });
    } else if (m.type === 'error' && !/buffer.*empty|commit_empty/i.test(JSON.stringify(m))) {
      log(`captions openai: ${JSON.stringify(m.error || m).slice(0, 200)}`);
    }
  });
  ws.on('error', (err) => log(`captions openai ws: ${err.message}`));
  return {
    audio(buf) {
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(frame(buf));
      else if (queue.length < 80) queue.push(frame(buf));
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      // Give the last segment a moment to finish, then report the final text.
      setTimeout(() => {
        emit({ text: tr.value(), final: true });
        try { ws.close(); } catch { /* closed */ }
      }, 900);
    },
  };
}

function createCaptions({ config, onCaption, log = () => {}, env = process.env }) {
  const engine = pickEngine(config, env);
  let current = null;
  let turn = 0;

  return {
    engine,
    start(mode = 'ptt') {
      if (engine === 'off') return false;
      if (current) current.stop();
      const id = ++turn;
      // Stale events from a finished turn never overwrite the new one.
      const emit = (c) => { if (id === turn) onCaption({ ...c, turn: id, engine }); };
      const key = engine === 'muse' ? env.META_API_KEY : env.OPENAI_API_KEY;
      if (!key) { log(`captions: no key for ${engine}`); return false; }
      current = (engine === 'muse' ? museSession : openaiSession)({ key, config, mode, emit, log });
      return true;
    },
    audio(buf) { if (current) current.audio(buf); },
    stop() { if (current) { current.stop(); current = null; } },
  };
}

module.exports = { createCaptions, pickEngine, createTranscript };
