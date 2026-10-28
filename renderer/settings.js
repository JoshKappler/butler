// The settings page in the panel: audio devices, the voice provider and each
// provider's voice, API keys, and the talk key. Main saves and restarts Butler.
const SettingsPage = (() => {
  const $ = (id) => document.getElementById(id);
  const ENGINES = { live: 'OpenAI GPT-Live', turns: 'Google Gemini', realtime: 'OpenAI Realtime' };
  // Keys that type a character: bound as the talk key, they stop typing it.
  const TYPING = /^([a-z0-9]|Space|Enter|Tab|Backspace|[-=[\];',./\\])$/;
  let state = null;
  let key = '';
  let recording = false;

  function options(sel, items, value) {
    sel.replaceChildren(...items.map(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      o.selected = v === value;
      return o;
    }));
  }

  function devices(sel, names, saved) {
    const items = [['', 'Windows default'], ...names.map((n) => [n, n])];
    if (saved && !names.includes(saved)) items.push([saved, `${saved} (not connected)`]);
    options(sel, items, saved);
  }

  const keyInput = (name) => document.querySelector(`#s-keys input[data-name="${name}"]`);

  function engineNote() {
    const k = state.keys.find((x) => x.name === 'OPENAI_API_KEY');
    const typed = keyInput('OPENAI_API_KEY');
    const missing = $('s-engine').value !== 'turns' && !(k && k.set) && !(typed && typed.value.trim());
    $('s-engine-note').textContent = missing ? 'Needs an OpenAI API key below. Until one is set, Gemini answers.' : '';
  }

  function rateText() {
    const v = Number($('s-tts-rate').value);
    return `${v >= 0 ? '+' : ''}${v}%`;
  }

  function renderKeys() {
    const box = $('s-keys');
    box.replaceChildren();
    for (const k of state.keys) {
      const row = document.createElement('label');
      row.className = 's-row';
      const name = document.createElement('span');
      name.textContent = k.name;
      const st = document.createElement('span');
      st.className = 's-key-state' + (k.set ? ' set' : '');
      st.textContent = !k.set ? 'Not set' : k.saved ? 'Saved' : 'From Windows';
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 's-key-input';
      input.dataset.name = k.name;
      input.placeholder = k.set ? 'Paste to replace' : 'Paste key';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.oninput = engineNote;
      row.append(name, st, input);
      box.appendChild(row);
    }
  }

  function showKey(note = '') {
    $('s-key').textContent = recording ? 'Press a key' : key;
    $('s-key').classList.toggle('recording', recording);
    $('s-key-note').textContent = note || (recording ? 'Esc cancels.' : TYPING.test(key) ? `${key} will stop typing its character everywhere.` : '');
  }

  async function open() {
    recording = false;
    $('s-error').textContent = '';
    $('s-save').disabled = false;
    $('s-save').textContent = 'Save and restart';
    state = await window.butler.settings();
    const [ins, outs] = await Promise.all([Devices.names('audioinput'), Devices.names('audiooutput')]).catch(() => [[], []]);
    devices($('s-input'), ins, state.audio.input);
    devices($('s-output'), outs, state.audio.output);
    const engines = ['live', 'turns', ...(state.engine === 'realtime' ? ['realtime'] : [])];
    options($('s-engine'), engines.map((e) => [e, ENGINES[e]]), state.engine);
    const voices = state.live.voices.includes(state.live.voice) ? state.live.voices : [state.live.voice, ...state.live.voices];
    options($('s-live-voice'), voices.map((v) => [v, v]), state.live.voice);
    $('s-tts-engine').value = state.tts.engine;
    $('s-tts-voice').value = state.tts.voice;
    $('s-tts-rate').value = parseInt(state.tts.rate, 10) || 0;
    $('s-tts-rate-out').textContent = rateText();
    key = state.key;
    showKey();
    renderKeys();
    engineNote();
    window.butler.edgeVoices().then((list) => {
      $('s-edge-voices').replaceChildren(...list.map((v) => { const o = document.createElement('option'); o.value = v; return o; }));
    });
  }

  async function save(e) {
    e.preventDefault();
    const keys = {};
    for (const input of document.querySelectorAll('#s-keys input')) if (input.value.trim()) keys[input.dataset.name] = input.value.trim();
    const s = {
      audio: { input: $('s-input').value, output: $('s-output').value },
      engine: $('s-engine').value,
      live: { voice: $('s-live-voice').value },
      tts: { engine: $('s-tts-engine').value, voice: $('s-tts-voice').value.trim(), rate: rateText() },
      key,
      keys,
    };
    $('s-save').disabled = true;
    $('s-error').textContent = '';
    try {
      await window.butler.saveSettings(s);
      $('s-save').textContent = 'Restarting';
    } catch (err) {
      $('s-error').textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('s-save').disabled = false;
    }
  }

  function init({ onClose }) {
    $('close-settings').innerHTML = Icons.svg('back', 16, 2.2);
    $('close-settings').onclick = onClose;
    $('s-cancel').onclick = onClose;
    $('settings').onsubmit = save;
    $('s-engine').onchange = engineNote;
    $('s-tts-rate').oninput = () => { $('s-tts-rate-out').textContent = rateText(); };
    $('s-key').onclick = () => { recording = true; showKey(); };
    // Capture phase, so Escape cancels the recording instead of closing the panel.
    window.addEventListener('keydown', (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') { recording = false; showKey(); return; }
      const name = KeyNames.fromCode(e.code);
      if (!name) { showKey(`${e.code} cannot be the talk key.`); return; }
      key = name;
      recording = false;
      showKey();
    }, true);
  }

  return { init, open };
})();
