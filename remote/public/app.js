// Butler on the phone: polls the relay for the PC's state and events, and
// queues commands for the PC. Voice input is the keyboard's dictation key.
(() => {
  const $ = (id) => document.getElementById(id);
  let cursor = 0;
  let state = null;
  let fastUntil = 0;
  let timer = null;
  let sheetTarget = null;
  let screenAt = 0;
  const waiting = new Map(); // command id -> its "working" bubble

  async function api(path, body) {
    const opts = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Butler': '1' },
      body: JSON.stringify(body),
    };
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) { showLogin(); throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.status);
    return data;
  }

  const command = async (cmd) => {
    fastUntil = Date.now() + 15000;
    const { id } = await api('/api/command', cmd);
    schedule(300);
    return id;
  };

  // ── sign in ────────────────────────────────────────────────────────────
  function showLogin() { $('login').hidden = false; $('app').hidden = true; clearTimeout(timer); }
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: $('passcode').value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'failed');
      $('passcode').value = '';
      start();
    } catch (err) { $('login-error').textContent = err.message; }
  };

  // ── rendering ──────────────────────────────────────────────────────────
  const feed = $('feed');
  function add(kind, content, html = false) {
    const el = document.createElement('div');
    el.className = kind;
    if (html) el.innerHTML = content; else el.textContent = content;
    feed.appendChild(el);
    while (feed.children.length > 120) feed.firstChild.remove();
    if (kind.startsWith('bubble')) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return el;
  }

  function row({ dot, title, sub, onClick, button }) {
    const el = document.createElement('div');
    el.className = 'row';
    if (dot !== undefined) { const d = document.createElement('span'); d.className = `dot ${dot}`; el.appendChild(d); }
    const m = document.createElement('div');
    m.className = 'main';
    m.innerHTML = '<div class="t"></div><div class="s"></div>';
    m.firstChild.textContent = title;
    m.lastChild.textContent = sub || '';
    el.appendChild(m);
    if (button) {
      const b = document.createElement('button');
      b.className = 'mini'; b.type = 'button'; b.textContent = button.label;
      b.onclick = (e) => { e.stopPropagation(); button.run(); };
      el.appendChild(b);
    }
    if (onClick) { const c = document.createElement('span'); c.className = 'chev'; c.textContent = '›'; el.appendChild(c); el.onclick = onClick; }
    return el;
  }

  function fill(id, items, make, empty) {
    const box = $(id);
    box.replaceChildren();
    if (!items.length && empty) { const r = row({ dot: '', title: empty }); r.classList.add('empty'); box.appendChild(r); }
    for (const it of items) box.appendChild(make(it));
  }

  function render(online, seen) {
    const st = $('status');
    st.classList.toggle('on', online);
    const host = (state && state.host) || 'PC';
    const mins = Math.round((Date.now() - seen) / 60000);
    st.lastChild.textContent = online ? `${host} online` : seen ? `${host} offline ${mins < 1 ? 'just now' : mins + 'm'}` : `${host} offline`;
    if (!state) return;

    const tiles = $('tiles');
    tiles.replaceChildren();
    for (const q of state.quickActions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      const running = q.tool === 'routine_start' && (state.routines || []).find((r) => r.kind === (q.args || {}).kind);
      if (running) b.classList.add('on');
      b.textContent = q.label;
      b.onclick = () => command(running ? { kind: 'tool', name: 'routine_stop', args: { id: running.id } } : { kind: 'tool', name: q.tool, args: q.args || {} });
      tiles.appendChild(b);
    }

    $('g-pending').hidden = !(state.pending || []).length;
    const box = $('pending');
    box.replaceChildren();
    for (const q of state.pending || []) {
      const el = document.createElement('div');
      el.className = 'question';
      el.innerHTML = '<div class="q"></div><div class="acts"><button class="primary" type="button">Allow</button><button type="button">Deny</button></div>';
      el.querySelector('.q').textContent = q.question;
      const [yes, no] = el.querySelectorAll('button');
      yes.onclick = () => command({ kind: 'answer', qid: q.id, answer: 'yes' });
      no.onclick = () => command({ kind: 'answer', qid: q.id, answer: 'no' });
      box.appendChild(el);
    }

    fill('agents', state.agents || [], (a) => row({
      dot: a.status, title: a.name, sub: [a.cli, a.status, a.title].filter(Boolean).join(' · '),
      onClick: a.visible === false ? null : () => openAgent(a),
    }), 'No agents running');

    $('g-routines').hidden = !(state.routines || []).length;
    fill('routines', state.routines || [], (r) => row({
      dot: 'working', title: r.label, sub: `${r.runs} runs`,
      button: { label: 'Stop', run: () => command({ kind: 'tool', name: 'routine_stop', args: { id: r.id } }) },
    }));

    if (state.screen && state.screen.at > screenAt) {
      screenAt = state.screen.at;
      $('screen').src = `/api/screen?t=${screenAt}`;
      $('screen').hidden = false;
    }
  }

  function onEvent(e) {
    switch (e.type) {
      case 'working': waiting.set(e.for, add('bubble butler working', 'Working on it')); break;
      case 'reply': {
        const w = waiting.get(e.for);
        if (w) { w.remove(); waiting.delete(e.for); }
        add('bubble butler', MD.render(e.text), true);
        break;
      }
      case 'result':
        if (e.name === 'agents' && e.args && e.args.action === 'read' && sheetTarget === e.args.target) {
          $('sheet-screen').textContent = (e.result && e.result.screen) || JSON.stringify(e.result);
        } else if (e.result && e.result.error) add('note', `${e.name}: ${e.result.error}`);
        break;
      case 'agent': {
        const a = e.agent || {};
        if (e.event === 'needs_input') add('note needs', `${a.name} needs you: ${e.summary || ''}`);
        else if (e.event === 'done' || e.event === 'failed') add('note', `${a.name} ${e.event === 'done' ? 'finished' : 'failed'}${e.summary ? ': ' + String(e.summary).slice(0, 140) : ''}`);
        else if (e.event === 'spawned') add('note', `Started ${a.name}`);
        break;
      }
      case 'computer':
        if (e.event === 'question') add('note needs', `On screen: ${e.question}`);
        if (e.event === 'done' || e.event === 'failed') add('note', `On screen: ${e.task.result || e.event}`);
        break;
      case 'card': add('card', `${e.title ? `<h3>${MD.esc(e.title)}</h3>` : ''}${MD.render(e.markdown)}`, true); break;
      case 'error': add('note needs', e.text); break;
      default: break;
    }
  }

  // ── polling ────────────────────────────────────────────────────────────
  async function poll() {
    try {
      const r = await api(`/api/state?after=${cursor}`);
      if (r.state) state = r.state;
      for (const e of r.events) { cursor = Math.max(cursor, e.id); onEvent(e); }
      render(r.pcOnline, r.pcSeen);
    } catch (err) {
      if (err.message !== 'signed out') $('status').lastChild.textContent = 'Relay unreachable';
    }
    if (!$('app').hidden) schedule(document.hidden ? 15000 : Date.now() < fastUntil ? 700 : 2500);
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(poll, ms); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(50); });

  // Old events load quietly on start: only the latest cursor matters.
  async function start() {
    $('login').hidden = true;
    $('app').hidden = false;
    try {
      const r = await api('/api/state?after=0');
      state = r.state;
      for (const e of r.events.slice(-30)) { cursor = Math.max(cursor, e.id); onEvent(e); }
      for (const e of r.events) cursor = Math.max(cursor, e.id);
      render(r.pcOnline, r.pcSeen);
    } catch { return; }
    schedule(1500);
  }

  // ── compose ────────────────────────────────────────────────────────────
  const text = $('text');
  text.oninput = () => {
    text.style.height = 'auto';
    text.style.height = `${Math.min(140, text.scrollHeight)}px`;
    $('composer').classList.toggle('ready', !!text.value.trim());
  };
  text.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } };
  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) return;
    text.value = '';
    text.oninput();
    add('bubble you', t);
    try { await command({ kind: 'text', text: t }); } catch (err) { add('note needs', `Not sent: ${err.message}`); }
  };

  // ── screen ─────────────────────────────────────────────────────────────
  $('btn-screen').onclick = () => command({ kind: 'screen' });
  $('tap-click').onchange = () => {
    $('control').hidden = !$('tap-click').checked;
    if ($('tap-click').checked && $('screen').hidden) command({ kind: 'screen' });
  };

  // Manual control on the screenshot: tap clicks, a quick second tap makes it
  // a double click, press and hold right-clicks. The PC sends a fresh
  // screenshot after each input, so the picture keeps up.
  let pressTimer = null, pressAt = null, tapTimer = null, lastTap = 0;
  const frac = (e) => { const r = $('screen').getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }; };
  $('screen').addEventListener('pointerdown', (e) => {
    if (!$('tap-click').checked) return;
    pressAt = frac(e);
    pressTimer = setTimeout(() => { pressTimer = null; if (navigator.vibrate) navigator.vibrate(12); command({ kind: 'click', button: 'right', ...pressAt }); }, 550);
  });
  $('screen').addEventListener('pointerup', () => {
    if (!$('tap-click').checked || !pressTimer) return;
    clearTimeout(pressTimer);
    pressTimer = null;
    const at = pressAt;
    if (Date.now() - lastTap < 320) {
      clearTimeout(tapTimer);
      lastTap = 0;
      command({ kind: 'click', double: true, ...at });
    } else {
      lastTap = Date.now();
      tapTimer = setTimeout(() => command({ kind: 'click', ...at }), 300);
    }
  });
  $('screen').addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });
  $('screen').addEventListener('contextmenu', (e) => e.preventDefault());

  const pcKeys = $('pc-keys');
  for (const [label, run] of [
    ['Enter', { kind: 'keys', keys: 'enter' }], ['Esc', { kind: 'keys', keys: 'esc' }], ['Tab', { kind: 'keys', keys: 'tab' }],
    ['Delete', { kind: 'keys', keys: 'backspace' }], ['Copy', { kind: 'keys', keys: 'ctrl+c' }], ['Paste', { kind: 'keys', keys: 'ctrl+v' }],
    ['Alt Tab', { kind: 'keys', keys: 'alt+tab' }], ['Start', { kind: 'keys', keys: 'win' }],
    ['Scroll up', { kind: 'scroll', fx: 0.5, fy: 0.5, dy: -5 }], ['Scroll down', { kind: 'scroll', fx: 0.5, fy: 0.5, dy: 5 }],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => command(run);
    pcKeys.appendChild(b);
  }
  $('pc-type').onsubmit = (e) => {
    e.preventDefault();
    const v = $('pc-text').value;
    if (!v) return;
    $('pc-text').value = '';
    command({ kind: 'type', text: v });
  };

  // ── voice: hold the mic to talk, or tap once to start and again to stop ─
  let recorder = null, chunks = [], recStart = 0, recTick = null, meterStop = null, holdMode = false;
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';

  async function startRecording() {
    if (recorder) return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (err) {
      add('note needs', `Microphone blocked: ${err.message}`);
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()); sendRecording(recorder.mimeType || mime); recorder = null; };
    recorder.start();
    recStart = Date.now();
    $('mic').classList.add('live');
    $('composer').classList.add('recording-on');
    $('recording').hidden = false;
    recTick = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 90) stopRecording();
    }, 250);
    meterStop = meter(stream);
    if (navigator.vibrate) navigator.vibrate(10);
  }

  function stopRecording() {
    if (!recorder) return;
    clearInterval(recTick);
    if (meterStop) meterStop();
    $('mic').classList.remove('live');
    $('composer').classList.remove('recording-on');
    $('recording').hidden = true;
    recorder.stop();
  }

  // A small live level meter, so it is obvious the phone is hearing you.
  function meter(stream) {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const cv = $('meter');
    const g = cv.getContext('2d');
    const bars = new Array(40).fill(0);
    let raf = 0;
    const draw = () => {
      const buf = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      bars.push(Math.min(1, Math.sqrt(sum / buf.length) * 6));
      bars.shift();
      g.clearRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#ff453a';
      bars.forEach((b, i) => { const h = Math.max(2, b * cv.height); g.fillRect(i * 6, (cv.height - h) / 2, 3, h); });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ctx.close(); };
  }

  async function sendRecording(type) {
    const blob = new Blob(chunks, { type: type || 'audio/mp4' });
    if (Date.now() - recStart < 400 || blob.size < 800) return;
    $('mic').classList.add('busy');
    const pending = add('bubble you working', 'Transcribing');
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST', credentials: 'same-origin', body: blob,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Type': blob.type, 'X-Butler': '1' },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) throw new Error(data.error || res.status);
      pending.remove();
      if (!data.text) { add('note', 'Heard nothing'); return; }
      add('bubble you', data.text);
      await command({ kind: 'text', text: data.text });
    } catch (err) {
      pending.remove();
      add('note needs', `Voice failed: ${err.message}`);
    } finally {
      $('mic').classList.remove('busy');
    }
  }

  let micDownAt = 0;
  $('mic').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (recorder && !holdMode) { stopRecording(); return; } // second tap of tap mode
    micDownAt = Date.now();
    holdMode = true;
    startRecording();
  });
  $('mic').addEventListener('pointerup', () => {
    if (!holdMode) return;
    // A quick tap switches to tap mode: keep recording until the next tap.
    if (Date.now() - micDownAt < 350) { holdMode = false; return; }
    holdMode = false;
    stopRecording();
  });
  $('mic').addEventListener('pointercancel', () => { if (holdMode) { holdMode = false; stopRecording(); } });

  // ── agent sheet ────────────────────────────────────────────────────────
  function openAgent(a) {
    sheetTarget = a.pane || a.name;
    $('sheet-title').textContent = a.name;
    $('sheet-screen').textContent = 'Reading...';
    const keys = $('sheet-keys');
    keys.replaceChildren();
    for (const [label, k] of [['1', '1'], ['2', '2'], ['3', '3'], ['Enter', 'enter'], ['Esc', 'esc'], ['Refresh', null]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = async () => {
        if (k) await command({ kind: 'tool', name: 'agents', args: { action: 'keys', target: sheetTarget, keys: [k] } });
        setTimeout(readAgent, k ? 600 : 0);
      };
      keys.appendChild(b);
    }
    $('sheet').showModal();
    readAgent();
  }
  const readAgent = () => command({ kind: 'tool', name: 'agents', args: { action: 'read', target: sheetTarget, lines: 50 } });
  $('sheet-close').onclick = () => { $('sheet').close(); sheetTarget = null; };
  $('sheet-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('sheet-input').value.trim();
    if (!v) return;
    $('sheet-input').value = '';
    await command({ kind: 'tool', name: 'agents', args: { action: 'tell', target: sheetTarget, text: v } });
    setTimeout(readAgent, 1500);
  };

  start();
})();
