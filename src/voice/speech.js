// Text to speech for the turn-based voice. Edge's neural voices answer in about
// half a second; Windows' own SAPI voice is the offline fallback.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sapi(text) {
  const file = path.join(os.tmpdir(), `butler-say-${process.pid}-${Date.now()}.wav`);
  const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:BUTLER_SAY_FILE); $s.Speak($env:BUTLER_SAY_TEXT); $s.Dispose()';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, BUTLER_SAY_FILE: file, BUTLER_SAY_TEXT: text }, windowsHide: true, timeout: 20000 }, (err) => {
        if (err) return reject(err);
        const audio = fs.readFileSync(file);
        fs.rmSync(file, { force: true });
        resolve({ mime: 'audio/wav', audio });
      });
  });
}

function createSpeech({ config, log = () => {} }) {
  const opts = config.voice.tts || {};
  let edge = null;

  async function edgeSay(text) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    if (!edge) {
      edge = new MsEdgeTTS();
      await edge.setMetadata(opts.voice || 'en-GB-RyanNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    }
    const { audioStream } = edge.toStream(text, { rate: opts.rate || '+0%' });
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });
    if (!chunks.length) throw new Error('edge returned no audio');
    return { mime: 'audio/mpeg', audio: Buffer.concat(chunks) };
  }

  async function synth(text) {
    if (opts.engine !== 'sapi') {
      try {
        return await edgeSay(text);
      } catch (err) {
        log(`speech: edge failed (${err.message}); using SAPI`);
        try { if (edge) edge.close(); } catch { /* already closed */ }
        edge = null;
      }
    }
    return sapi(text);
  }

  return { synth };
}

module.exports = { createSpeech };
