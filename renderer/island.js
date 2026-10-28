// The island's body: its size for each view, the glass, the desktop behind
// it, where clicks may land, and the Siri wave. dock.js decides which
// view to show; this file makes the change look right.
const Island = (() => {
  const island = document.getElementById('island');
  const voiceLayer = document.getElementById('voice');
  const heard = document.getElementById('heard');
  const reply = document.getElementById('reply');

  // Width, height, corner radius. Apple's island uses height/2 when compact
  // and 44pt when expanded; desktop sizes are a touch larger than a phone's.
  const SHAPE = {
    off: [150, 36, 18],
    live: [260, 38, 19],
    alert: [460, 72, 36],
    wave: [240, 46, 23],
    voice: [520, 128, 40],
    panel: [800, 660, 44],
  };
  // Light angles: degrees, 0 = from the right, 90 = above.
  let lightDeg = 136;

  let view = 'off';
  let hideTimer = null;
  let backdropAt = 0;
  let overIsland = false;
  let onChangeCb = () => {};

  function setShape(w, h, r) {
    island.style.setProperty('--w', `${Math.round(w)}px`);
    island.style.setProperty('--h', `${Math.round(h)}px`);
    island.style.setProperty('--r', `${r}px`);
  }

  function initGlass() {
    try {
      Glass.init({ stage: document.getElementById('stage'), island, panel: document.getElementById('panel'), lightAngle: lightDeg });
    } catch (err) { window.butler.log(`glass: ${err.message}`); }
  }

  function setBackdrop(url) {
    const img = new Image();
    img.onload = () => Glass.setBackdrop(img);
    img.src = url;
  }

  async function refreshBackdrop(force = false) {
    if (!force && Date.now() - backdropAt < 1500) return;
    backdropAt = Date.now();
    const url = await window.butler.backdrop();
    if (url && view !== 'off') setBackdrop(url);
  }

  // Text is measured at the width the island is heading to, not the width it
  // has mid-morph, or a pill-wide measure would wrap into eight lines.
  const measurer = document.createElement('div');
  measurer.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;font:500 17px/23px var(--font);letter-spacing:-0.017em;';
  document.body.appendChild(measurer);
  function lines(text, width) {
    if (!text) return 1;
    measurer.style.width = `${width}px`;
    measurer.textContent = text;
    return Math.max(1, Math.round(measurer.offsetHeight / 23));
  }

  function voiceHeight() {
    const inner = SHAPE.voice[0] - 44;
    const answering = voiceLayer.classList.contains('answering');
    const heardText = heard.textContent;
    const replyText = reply.textContent;
    const heardH = answering ? 18 : 23 * Math.min(2, lines(heardText, inner));
    const replyH = answering ? 23 * Math.min(4, lines(replyText, inner)) + 4 : 0;
    return 6 + 58 + heardH + replyH + 16;
  }

  function liveWidth() {
    const text = document.getElementById('live-text').textContent;
    const trail = document.getElementById('live-trail').textContent;
    const ctx = liveWidth.ctx || (liveWidth.ctx = document.createElement('canvas').getContext('2d'));
    ctx.font = '550 13px "Inter Variable", Inter, sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.font = '400 12px "Inter Variable", Inter, sans-serif';
    const rw = trail ? ctx.measureText(trail).width + 9 : 0;
    return Math.max(180, Math.min(420, 8 + 24 + 9 + tw + rw + 16));
  }

  function fit() {
    const [w, h, r] = SHAPE[view];
    if (view === 'voice') setShape(w, voiceHeight(), r);
    else if (view === 'live') setShape(liveWidth(), h, r);
    else setShape(w, h, r);
  }

  function setView(next) {
    if (next === view) { fit(); return; }
    const prev = view;
    view = next;
    const shrinking = next === 'off' || (SHAPE[next][0] * SHAPE[next][1] < SHAPE[prev][0] * SHAPE[prev][1]);
    island.classList.toggle('collapsing', shrinking);
    clearTimeout(hideTimer);
    if (next !== 'off') {
      window.butler.visible(true);
      Glass.run(true);
      // Show the frame first, then morph, so the first paint is the old shape.
      requestAnimationFrame(() => {
        island.dataset.view = next;
        fit();
        sweepLight();
      });
      if (prev === 'off' || next === 'panel') refreshBackdrop(next === 'panel');
    } else {
      island.dataset.view = 'off';
      fit();
      hideTimer = setTimeout(() => { if (view === 'off') { Glass.run(false); window.butler.visible(false); } }, 700);
    }
    window.butler.panelState(next === 'panel');
    onChangeCb(next, prev);
  }

  // The rim light leans at most 30 degrees toward the pointer and eases there
  // (glass.js), and sweeps once around the rim whenever the island changes shape.
  const REST_DEG = 136;
  function setLight(deg, instant) {
    Glass.setLight(deg, instant);
  }
  function aimLight(x, y) {
    const r = island.getBoundingClientRect();
    const toward = Math.atan2((r.top + r.height / 2) - y, x - (r.left + r.width / 2)) * 180 / Math.PI;
    const off = ((toward - REST_DEG) % 360 + 540) % 360 - 180;
    lightDeg = REST_DEG + Math.max(-30, Math.min(30, off));
    setLight(lightDeg);
  }
  let sweep = 0;
  function sweepLight() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = lightDeg, t0 = performance.now(), id = ++sweep;
    const step = (now) => {
      if (id !== sweep) return;
      const t = Math.min(1, (now - t0) / 1100);
      setLight(from + 360 * (1 - Math.pow(1 - t, 3)), true);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Click-through everywhere except the glass. Mouse moves still arrive while
  // the window ignores clicks, so hovering the island turns clicks back on.
  document.addEventListener('mousemove', (e) => {
    const over = view !== 'off' && !!e.target.closest && !!e.target.closest('#island');
    if (over !== overIsland) { overIsland = over; window.butler.hit(over); }
    if (view !== 'off') { sweep++; aimLight(e.clientX, e.clientY); }
  });
  document.addEventListener('mouseleave', () => { if (overIsland) { overIsland = false; window.butler.hit(false); } });

  // ── the wave ─────────────────────────────────────────────────────────────
  let wave = null, headWave = null, pillWave = null;
  let analyser = null, outLevel = 0;
  let waveMode = 'idle';
  let fake = null;

  function initWaves() {
    if (typeof SiriWave === 'undefined') return;
    const ratio = window.devicePixelRatio || 1;
    // Fuller, wider curves than the library default, closer to the real Siri wisp.
    const ranges = { width: [1.4, 3.2], amplitude: [0.55, 1], noOfCurves: [3, 5] };
    // The library's flat support line fades unevenly (10% on the left, 20% on
    // the right), so it is left out and dock.css draws a centered one.
    const curveDefinition = [{ color: '15, 82, 169' }, { color: '173, 57, 76' }, { color: '48, 220, 155' }];
    // siriwave centers its curves 6 device pixels above the canvas middle.
    const make = (id, width, height, speed, extra = {}) => {
      const w = new SiriWave({ container: document.getElementById(id), style: 'ios9', width, height, amplitude: 0, speed, autostart: true, lerpSpeed: 0.14, ratio, curveDefinition, ...extra });
      w.canvas.style.top = `${6 / ratio}px`;
      return w;
    };
    wave = make('wave', 500, 58, 0.12, { ranges });
    pillWave = make('pill-wave', 200, 40, 0.12, { ranges });
    headWave = make('p-wave', 600, 110, 0.12, { ranges });
  }

  // Called once per reply: a captured stream's tracks end when the player
  // loads the next clip, so each reply brings a fresh stream.
  let outCtx = null, outSource = null;
  function setOutputStream(stream) {
    if (!outCtx) {
      outCtx = new AudioContext();
      analyser = outCtx.createAnalyser();
      analyser.fftSize = 512;
    }
    if (outSource) outSource.disconnect();
    outSource = outCtx.createMediaStreamSource(stream);
    outSource.connect(analyser);
  }

  function outputLevel() {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += ((v - 128) / 128) ** 2;
    outLevel = outLevel * 0.6 + Math.sqrt(s / buf.length) * 0.4;
    return outLevel;
  }

  // The mic runs without gain control, so its level follows the Windows mic
  // volume. Scale to the loudest recent speech so it fills the wave at any
  // volume; a quiet room (about 0.001) stays flat.
  let micPeak = 0.004;
  function micAmp() {
    const l = Mic.level();
    micPeak = Math.max(l, micPeak * 0.995, 0.004);
    return l < 0.002 ? 0 : Math.min(3, (l / micPeak) * 2.8);
  }

  // siriwave brings a curve back only when its height falls below 2px, which
  // never happens at amplitude 0, so curves that fade out at rest stay dead.
  // Respawn any wave whose curves have all faded (2s is the longest they live).
  function revive(w) {
    for (const c of w.curves) {
      if (c.spawnAt && Date.now() - c.spawnAt > 2000 && c.prevMaxY < c.DEAD_PX) c.spawnAt = 0;
    }
  }

  function tick() {
    for (const w of [wave, headWave, pillWave]) if (w) revive(w);
    let amp = 0, speed = 0.08;
    if (fake !== null) { amp = fake; speed = 0.14; }
    else if (waveMode === 'listening') { amp = micAmp(); speed = 0.13; }
    else if (waveMode === 'speaking') { amp = Math.min(3, 0.3 + outputLevel() * 18); speed = 0.16; }
    else if (waveMode === 'thinking') { amp = 0.6; speed = 0.05; }
    if (wave) { wave.setAmplitude(amp); wave.setSpeed(speed); }
    if (headWave) { headWave.setAmplitude(Math.min(4, amp * 2)); headWave.setSpeed(speed); }
    if (pillWave) { pillWave.setAmplitude(Math.min(3, amp * 1.5)); pillWave.setSpeed(speed); }
    requestAnimationFrame(tick);
  }

  // ── captions and replies ─────────────────────────────────────────────────
  // Words that are new since the last update fade in; words that stayed the
  // same are left alone, so a streaming transcript does not flicker.
  function renderWords(el, text) {
    let inner = el.firstElementChild;
    if (!inner) { inner = document.createElement('div'); el.appendChild(inner); }
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const kids = [...inner.children];
    let same = 0;
    while (same < words.length && same < kids.length && kids[same].dataset.w === words[same]) same++;
    for (const k of kids.slice(same)) k.remove();
    for (const w of words.slice(same)) {
      const span = document.createElement('span');
      span.className = 'w new';
      span.dataset.w = w;
      span.textContent = w + ' ';
      inner.appendChild(span);
    }
    inner.scrollTop = inner.scrollHeight;
  }

  function setHeard(text, hint) {
    if (hint !== undefined) heard.dataset.hint = hint;
    if (!text) heard.replaceChildren();
    else renderWords(heard, text);
    if (view === 'voice') fit();
  }

  function setReply(text, { status = false } = {}) {
    voiceLayer.classList.toggle('answering', !!text);
    if (status) { reply.replaceChildren(); const s = document.createElement('span'); s.className = 'shimmer'; s.textContent = text; reply.appendChild(s); }
    else if (!text) reply.replaceChildren();
    else { if (reply.querySelector('.shimmer')) reply.replaceChildren(); renderWords(reply, text); }
    if (view === 'voice') fit();
  }

  function setWaveMode(m) {
    waveMode = m;
    voiceLayer.classList.toggle('thinking', m === 'thinking');
  }

  function init() {
    fit();
    initGlass();
    initWaves();
    requestAnimationFrame(tick);
  }

  return {
    init, setView, fit, view: () => view, setHeard, setReply, setWaveMode, setOutputStream,
    refreshBackdrop, setBackdrop, onChange: (cb) => { onChangeCb = cb; }, fakeLevel: (v) => { fake = v; },
  };
})();
