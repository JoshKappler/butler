// POST raw audio from the phone's mic -> {text}. Transcribed with OpenAI; the
// phone then sends the text like anything typed. The vocabulary hint keeps
// names like herdr and Codex from turning into "herder" and "codecs".
const { isPhone } = require('../lib/auth');

const EXT = { 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isPhone(req)) return res.status(401).json({ error: 'sign in' });
  if (req.headers['x-butler'] !== '1') return res.status(403).json({ error: 'bad request origin' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on Vercel' });
  // Sent as application/octet-stream, which Vercel hands over as a Buffer.
  const audio = Buffer.isBuffer(req.body) ? req.body : null;
  if (!audio || audio.length < 800) return res.status(400).json({ error: 'no audio' });
  if (audio.length > 4e6) return res.status(413).json({ error: 'recording too long' });
  const type = String(req.headers['x-audio-type'] || 'audio/mp4').split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), `speech.${EXT[type] || 'm4a'}`);
  form.append('model', process.env.BUTLER_STT_MODEL || 'gpt-4o-transcribe');
  form.append('language', 'en');
  form.append('prompt', 'Butler, herdr, Claude, Codex, Fable, Opus, MOLE, Steam, BOFFY.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: (data.error && data.error.message) || `transcription ${r.status}` });
  res.status(200).json({ text: String(data.text || '').trim() });
};
