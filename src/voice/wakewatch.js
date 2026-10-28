// "Butler" wake word over an always-on Realtime transcription session (no LLM,
// no replies). The dock streams 24kHz PCM16 in only while it hears speech, so
// a quiet room costs nothing. Ported from chud's wakewatch.
const WebSocket = require('ws');

const WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_AGE_MS = 55 * 60 * 1000;

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Finds the wake word and returns whatever was said after it, so
// "Butler, open Steam" acts at once without a second utterance.
function parseWake(text, aliases) {
  const words = normalize(text).split(' ');
  const i = words.findIndex((w) => aliases.includes(w));
  if (i < 0) return null;
  return { command: words.slice(i + 1).join(' ').trim() };
}

function createWakewatch({ config, onWake, log = () => {} }) {
  const cfg = config.wake;
  const aliases = cfg.aliases.map((a) => a.toLowerCase());
  let ws = null;
  let enabled = false;
  let backoff = 1000;
  let openedAt = 0;
  let refresh = null;
  let lastFire = 0;

  function sessionUpdate() {
    const transcription = { model: cfg.transcribeModel, language: 'en' };
    // Keyword biasing is only accepted by the live-transcribe models.
    if (/^gpt-live-transcribe/.test(cfg.transcribeModel)) transcription.keywords = cfg.keywords;
    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'near_field' },
            transcription,
            turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 400 },
          },
        },
      },
    };
  }

  function handle(msg) {
    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      const hit = parseWake(msg.transcript, aliases);
      if (hit && Date.now() - lastFire > 2500) {
        lastFire = Date.now();
        onWake(hit);
      }
    } else if (msg.type === 'error') {
      log(`wakewatch error: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  }

  function connect() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return log('wakewatch: OPENAI_API_KEY missing, wake word off');
    ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${key}` } });
    ws.on('open', () => { openedAt = Date.now(); backoff = 1000; ws.send(JSON.stringify(sessionUpdate())); });
    ws.on('message', (d) => { try { handle(JSON.parse(d)); } catch { /* ignore */ } });
    ws.on('error', (err) => log(`wakewatch ws: ${err.message}`));
    ws.on('close', () => {
      ws = null;
      if (enabled) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }
    });
  }

  return {
    start() {
      if (enabled) return;
      enabled = true;
      connect();
      refresh = setInterval(() => {
        if (ws && Date.now() - openedAt > MAX_AGE_MS) try { ws.close(); } catch { /* reconnects */ }
      }, 60000);
    },
    append(buf) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(buf).toString('base64') }));
      }
    },
    stop() {
      enabled = false;
      clearInterval(refresh);
      if (ws) try { ws.close(); } catch { /* closing */ }
      ws = null;
    },
  };
}

module.exports = { createWakewatch, parseWake, normalize };
