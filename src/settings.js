// The dock's settings page, main side. Reads what the page shows and writes
// what it saves: choices go to %APPDATA%\Butler\config.json, keys to the .env
// beside it. Key values never travel back to the page, only whether one is set.
const fs = require('fs');
const path = require('path');
const { merge } = require('./config');

// Single keys AutoHotkey can bind as a hold-to-talk key.
const KEY_NAME = /^([a-z0-9]|F([1-9]|1\d|2[0-4])|Numpad(\d|Add|Sub|Mult|Div|Dot|Enter)|[LR](Ctrl|Alt|Shift|Win)|Pause|ScrollLock|PrintScreen|Insert|Delete|Home|End|PgUp|PgDn|Up|Down|Left|Right|CapsLock|NumLock|Tab|Space|Enter|Backspace|AppsKey|[-=[\];',./\\])$/;
const KEY_ENV = /^[A-Z][A-Z0-9_]*$/;

function readEnvFile(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out.set(m[1], true);
  }
  return out;
}

// Replaces NAME=... lines in place and appends the rest, keeping comments.
function writeEnvFile(file, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const left = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (!m || !left.has(m[1])) return line;
    const v = left.get(m[1]);
    left.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.join('\n') + '\n');
}

function keyEnvs(config) {
  return [...new Set(Object.values(config.providers).map((p) => p.keyEnv).filter(Boolean))];
}

function createSettings({ config, dir, env = process.env }) {
  const cfgFile = path.join(dir, 'config.json');
  const envFile = path.join(dir, '.env');
  const keyFile = path.join(config.stateDir, 'ptt-key');

  // AutoHotkey reads the talk key from this file when it starts.
  function writeKeyFile() {
    const key = config.hotkeys.key || 'Pause';
    if (!fs.existsSync(keyFile) || fs.readFileSync(keyFile, 'utf8').trim() !== key) fs.writeFileSync(keyFile, key);
  }

  function read() {
    const saved = readEnvFile(envFile);
    return {
      audio: { input: config.audio.input || '', output: config.audio.output || '' },
      engine: config.voice.engine,
      live: { voice: config.voice.live.voice, voices: config.voice.live.voices || [] },
      tts: { engine: config.voice.tts.engine, voice: config.voice.tts.voice, rate: config.voice.tts.rate },
      key: config.hotkeys.key || 'Pause',
      keys: keyEnvs(config).map((name) => ({ name, set: !!env[name], saved: saved.has(name) })),
    };
  }

  // Returns { keyChanged } so main knows to restart the key script.
  function save(s) {
    const over = {};
    if (s.audio) over.audio = { input: String(s.audio.input || ''), output: String(s.audio.output || '') };
    const voice = {};
    if (['live', 'turns', 'realtime'].includes(s.engine)) voice.engine = s.engine;
    if (s.live && s.live.voice) voice.live = { voice: String(s.live.voice) };
    if (s.tts) {
      voice.tts = {};
      if (['edge', 'sapi'].includes(s.tts.engine)) voice.tts.engine = s.tts.engine;
      if (s.tts.voice) voice.tts.voice = String(s.tts.voice);
      if (/^[+-]\d{1,3}%$/.test(s.tts.rate || '')) voice.tts.rate = s.tts.rate;
    }
    if (Object.keys(voice).length) over.voice = voice;
    const prevKey = config.hotkeys.key || 'Pause';
    if (s.key !== undefined) {
      if (!KEY_NAME.test(s.key)) throw new Error(`${s.key} cannot be the talk key`);
      over.hotkeys = { key: s.key };
    }

    const current = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    fs.writeFileSync(cfgFile, JSON.stringify(merge(current, over), null, 2) + '\n');

    const names = keyEnvs(config);
    const keys = {};
    for (const [name, value] of Object.entries(s.keys || {})) {
      const v = String(value || '').trim();
      if (!v) continue;
      if (!KEY_ENV.test(name) || !names.includes(name)) throw new Error(`unknown key ${name}`);
      if (/[\r\n]/.test(v)) throw new Error(`${name} has a line break`);
      keys[name] = v;
    }
    if (Object.keys(keys).length) writeEnvFile(envFile, keys);

    Object.assign(config, merge(config, over));
    writeKeyFile();
    return { keyChanged: config.hotkeys.key !== prevKey };
  }

  return { read, save, writeKeyFile };
}

module.exports = { createSettings, writeEnvFile, KEY_NAME };
