const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createSettings } = require('../src/settings');
const KeyNames = require('../renderer/keynames');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'butler-test-'));

function setup(env = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), '# keys\nGEMINI_API_KEY=old-gemini\nOPENAI_API_KEY=\nBUTLER_PC_TOKEN=pc\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ _note: 'mine', voice: { historyTurns: 5 } }));
  const config = loadConfig({ dir });
  return { dir, config, settings: createSettings({ config, dir, env }) };
}

test('settings page sees whether a key is set, never its value', () => {
  const { settings } = setup({ GEMINI_API_KEY: 'old-gemini', ANTHROPIC_API_KEY: 'from-windows' });
  const s = settings.read();
  assert.ok(!JSON.stringify(s).includes('old-gemini') && !JSON.stringify(s).includes('from-windows'));
  const by = Object.fromEntries(s.keys.map((k) => [k.name, k]));
  assert.deepEqual(by.GEMINI_API_KEY, { name: 'GEMINI_API_KEY', set: true, saved: true });
  assert.deepEqual(by.ANTHROPIC_API_KEY, { name: 'ANTHROPIC_API_KEY', set: true, saved: false });
  assert.equal(by.OPENAI_API_KEY.set, false);
  assert.equal(s.key, 'Pause');
});

test('saving merges into config.json and fills the .env line in place', () => {
  const { dir, settings } = setup();
  const r = settings.save({
    audio: { input: 'Main Mic', output: '' }, engine: 'live', live: { voice: 'cinder' },
    tts: { engine: 'edge', voice: 'en-US-GuyNeural', rate: '+35%' }, key: 'F14',
    keys: { OPENAI_API_KEY: ' sk-new ', GEMINI_API_KEY: '' },
  });
  assert.equal(r.keyChanged, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg._note, 'mine');
  assert.equal(cfg.voice.historyTurns, 5);
  assert.equal(cfg.voice.live.voice, 'cinder');
  assert.equal(cfg.voice.tts.rate, '+35%');
  assert.equal(cfg.hotkeys.key, 'F14');
  assert.equal(cfg.audio.input, 'Main Mic');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), '# keys\nGEMINI_API_KEY=old-gemini\nOPENAI_API_KEY=sk-new\nBUTLER_PC_TOKEN=pc\n');
  assert.equal(fs.readFileSync(path.join(dir, 'state', 'ptt-key'), 'utf8'), 'F14');
  assert.equal(settings.save({ key: 'F14' }).keyChanged, false);
});

test('saving refuses keys outside the providers and unbindable talk keys', () => {
  const { settings } = setup();
  assert.throws(() => settings.save({ keys: { BUTLER_PC_TOKEN: 'x' } }), /unknown key/);
  assert.throws(() => settings.save({ keys: { OPENAI_API_KEY: 'a\nB=c' } }), /line break/);
  assert.throws(() => settings.save({ key: 'Esc' }), /cannot be the talk key/);
  assert.throws(() => settings.save({ key: 'F25' }), /cannot be the talk key/);
});

test('a key saved in the Butler .env beats the inherited environment', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'BUTLER_TEST_KEY=saved\nBUTLER_TEST_EMPTY=\n');
  process.env.BUTLER_TEST_KEY = 'inherited';
  process.env.BUTLER_TEST_EMPTY = 'inherited';
  loadConfig({ dir });
  assert.equal(process.env.BUTLER_TEST_KEY, 'saved');
  assert.equal(process.env.BUTLER_TEST_EMPTY, 'inherited');
  delete process.env.BUTLER_TEST_KEY;
  delete process.env.BUTLER_TEST_EMPTY;
});

test('recorded key presses become AutoHotkey key names', () => {
  assert.equal(KeyNames.fromCode('Pause'), 'Pause');
  assert.equal(KeyNames.fromCode('KeyG'), 'g');
  assert.equal(KeyNames.fromCode('Digit7'), '7');
  assert.equal(KeyNames.fromCode('F13'), 'F13');
  assert.equal(KeyNames.fromCode('F25'), null);
  assert.equal(KeyNames.fromCode('PageDown'), 'PgDn');
  assert.equal(KeyNames.fromCode('ControlRight'), 'RCtrl');
  assert.equal(KeyNames.fromCode('Numpad0'), 'Numpad0');
  assert.equal(KeyNames.fromCode('Escape'), null);
});
