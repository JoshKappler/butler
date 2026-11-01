// The dock's brain: turns Pause, the wake word, the voice session and
// background work into one island view, and fills the panel.
(async () => {
  const $ = (id) => document.getElementById(id);
  const cfg = await window.butler.config();
  const Voice = { realtime: RealtimeVoice, live: LiveVoice }[cfg.voice.engine] || TurnVoice;

  const S = {
    voice: 'idle',      // idle | listening | thinking | speaking
    convo: false,
    panel: false,
    alert: null,        // { kind, title, body }
    linger: false,      // keep the reply on screen a moment after Butler stops
    quiet: false,       // a Pause hold shows only the wave, no words
    armed: false,       // Pause is down but not yet long enough to be a hold
    heard: '',
    reply: '',
    replyId: null,
    agents: [], routines: [], tasks: [], pending: [], recent: [],
  };
  let lingerTimer = null;
  let alertTimer = null;

  // ── which view ─────────────────────────────────────────────────────────
  function liveItems() {
    const items = [];
    if (S.pending.length) items.push({ tone: 'needs', icon: 'bell', text: S.pending[0].question.split('\n')[0], count: S.pending.length });
    const tasks = S.tasks.filter((t) => t.status === 'working' || t.status === 'asking');
    if (tasks.length) items.push({ tone: 'busy', icon: 'cursor', text: tasks[0].goal, count: tasks.length });
    const busy = S.agents.filter((a) => a.status === 'working' || a.status === 'blocked');
    if (busy.length) items.push({ tone: busy.some((a) => a.status === 'blocked') ? 'needs' : 'busy', icon: 'terminal', text: `${busy.length} agent${busy.length > 1 ? 's' : ''} working`, count: busy.length });
    if (S.routines.length) items.push({ tone: 'busy', icon: 'repeat', text: S.routines[0].label, count: S.routines.length });
    return items;
  }

  function view() {
    if (S.panel) return 'panel';
    // A turn waiting on Josh's OK shows the question, not the wave.
    if (S.pending.length && S.voice === 'thinking') return 'live';
    if ((S.voice !== 'idle' || S.linger) && !S.quiet) return 'voice';
    if (S.voice !== 'idle' && !S.armed) return 'wave';
    if (S.alert) return 'alert';
    if (cfg.dock.liveActivities && liveItems().length) return 'live';
    return 'off';
  }

  function render() {
    renderLive();
    Island.setView(view());
  }

  // ── live activity pill ───────────────────────────────────────────────────
  function renderLive() {
    const items = liveItems();
    const lead = $('live-lead');
    if (!items.length) return;
    const top = items[0];
    lead.innerHTML = Icons.svg(top.icon, 14, 2.1);
    lead.classList.toggle('busy', top.tone === 'busy');
    lead.style.background = top.tone === 'needs' ? 'rgba(255,159,10,.22)' : '';
    lead.style.color = top.tone === 'needs' ? 'var(--orange)' : '';
    $('live-text').textContent = top.text;
    $('live-trail').textContent = items.length > 1 ? `+${items.length - 1}` : '';
  }

  // ── voice ────────────────────────────────────────────────────────────────
  function setVoice(v) {
    if ((v === 'speaking') !== (S.voice === 'speaking')) window.butler.speaking(v === 'speaking');
    S.voice = v;
    Island.setWaveMode(v);
    if (v !== 'idle') { clearTimeout(lingerTimer); S.linger = false; }
    render();
  }

  // After Butler finishes, its answer stays readable for a few seconds.
  function settle() {
    if (S.voice !== 'idle') return;
    if (S.reply && !S.panel) {
      S.linger = true;
      clearTimeout(lingerTimer);
      const ms = Math.min(9000, 2600 + S.reply.split(/\s+/).length * 180);
      lingerTimer = setTimeout(() => { S.linger = false; render(); }, ms);
    }
    render();
  }

  function startListening(mode) {
    S.heard = '';
    S.reply = '';
    S.replyId = null;
    Island.setReply('');
    Island.setHeard('', mode === 'convo' ? 'Go ahead' : 'Listening');
    if (cfg.captions !== 'off') { Mic.setFeed('captions'); window.butler.captions('start', mode); }
    else Mic.setFeed(null);
  }

  function stopListening() {
    // A short tail so the last word reaches the captions stream.
    setTimeout(() => {
      window.butler.captions('stop');
      if (S.voice !== 'listening') Mic.setFeed('wake');
    }, 180);
  }

  const TOOL_STATUS = {
    web_search: 'Searching the web', open: 'Opening', ask_files: 'Looking through your files', find_files: 'Finding files',
    computer_task: 'Starting on it', spawn_agent: 'Starting an agent', agents: 'Checking the agents', routine_start: 'Setting that up',
    run_powershell: 'Running it', read_file: 'Reading', windows: 'Switching windows', media: 'Adjusting', keyboard: 'Typing',
  };

  // ── panel content ────────────────────────────────────────────────────────
  const feed = $('feed');
  function feedAdd(kind, content, { html = false } = {}) {
    const el = document.createElement('div');
    el.className = kind;
    if (html) el.innerHTML = content; else el.textContent = content;
    feed.appendChild(el);
    while (feed.children.length > 160) feed.firstChild.remove();
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  const tool = (name, args) => window.butler.tool(name, args);
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  };

  function renderPanel() {
    $('g-pending').hidden = !S.pending.length;
    const box = $('pending');
    box.replaceChildren();
    for (const q of S.pending) {
      const el = document.createElement('div');
      el.className = 'question';
      const text = document.createElement('div');
      text.className = 'q';
      text.textContent = q.question;
      const acts = document.createElement('div');
      acts.className = 'acts';
      const answer = (v) => window.butler.answer(q.id, v);
      const yes = document.createElement('button');
      yes.className = 'pill-button primary';
      yes.type = 'button';
      yes.textContent = 'Allow';
      yes.onclick = () => answer('yes');
      const no = document.createElement('button');
      no.className = 'pill-button';
      no.type = 'button';
      no.textContent = 'Deny';
      no.onclick = () => answer('no');
      const input = document.createElement('input');
      input.placeholder = 'Or answer';
      input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) answer(input.value.trim()); };
      acts.append(yes, no, input);
      el.append(text, acts);
      box.appendChild(el);
    }

    renderChats();
  }

  // ── chat history ─────────────────────────────────────────────────────────
  // The left column lists saved chats; picking an old one shows it in place of
  // the live conversation until Josh picks the current one or speaks again.
  let viewing = null;
  let chatList = [];
  let loadChats = () => window.butler.chats();
  async function renderChats(list) {
    if (list) chatList = list;
    else { try { chatList = await loadChats(); } catch { chatList = []; } }
    const box = $('chats');
    box.replaceChildren();
    if (!chatList.length) { const e = document.createElement('div'); e.className = 'chat-empty'; e.textContent = 'No chats yet'; box.appendChild(e); }
    for (const c of chatList) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'chat' + ((viewing ? viewing === c.id : c.current || c.id === feedChat) ? ' on' : '');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = c.title;
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = c.current ? 'Now' : ago(c.updated);
      el.append(t, s);
      el.onclick = () => showChat(c.current ? null : c.id);
      box.appendChild(el);
    }
  }

  async function showChat(id) {
    viewing = id;
    $('feed').hidden = !!id;
    $('past').hidden = !id;
    if (id) {
      const chat = await window.butler.chat(id);
      const past = $('past');
      past.replaceChildren();
      for (const t of (chat && chat.turns) || []) past.append(bubble('you', t.heard), bubble('butler', t.answer));
      past.scrollTop = 0;
    }
    renderChats(chatList);
  }

  function bubble(who, text) {
    const el = document.createElement('div');
    el.className = `bubble ${who}`;
    el.textContent = text;
    return el;
  }

  // The live feed shows the current chat; at startup, the latest one even when
  // it has expired. A turn that starts a new chat clears it.
  let feedChat = null;
  async function syncFeed(latest = false) {
    const list = await window.butler.chats().catch(() => []);
    const live = list.find((c) => c.current) || (latest && list[0]);
    if (!live || live.id === feedChat) return;
    const chat = await window.butler.chat(live.id);
    if (!chat) return;
    feedChat = live.id;
    feed.replaceChildren(...chat.turns.flatMap((t) => [bubble('you', t.heard), bubble('butler', t.answer)]));
    feed.scrollTop = feed.scrollHeight;
  }

  // A turn shows in the feed the moment it starts: Josh's words (a placeholder
  // until the voice lane hears them) and a status line that becomes the answer.
  // A turn that starts after the chat expired clears the old chat first.
  let turnRow = null;
  function beginTurn(text) {
    if (turnRow) return;
    if (viewing) showChat(null);
    const row = turnRow = { you: feedAdd('bubble you', text || '…'), status: feedAdd('bubble butler status', '') };
    setTurnStatus('Thinking');
    window.butler.chats().catch(() => []).then((list) => {
      if (list.some((c) => c.current)) return;
      feedChat = null;
      for (const el of [...feed.children]) if (el !== row.you && el !== row.status) el.remove();
    });
  }

  function setTurnStatus(text, needs = false) {
    if (!turnRow) return;
    const s = document.createElement('span');
    s.className = 'shimmer';
    s.textContent = text;
    turnRow.status.replaceChildren(s);
    turnRow.status.classList.toggle('needs', needs);
  }

  // Returns false when no turn was showing.
  function endTurn(answer, note = 'Nothing heard') {
    if (!turnRow) return false;
    const { you, status } = turnRow;
    turnRow = null;
    if (answer) { status.className = 'bubble butler'; status.textContent = answer; return true; }
    status.remove();
    if (you.textContent === '…') { you.remove(); if (note) feedAdd('note', note); }
    return true;
  }

  async function refresh() {
    try { Object.assign(S, await window.butler.snapshot()); } catch (err) { window.butler.log('snapshot ' + err.message); }
    if (S.panel) renderPanel();
    render();
  }

  // ── panel open and close ─────────────────────────────────────────────────
  function openPanel(open) {
    S.panel = open;
    if (!open) showSettings(false);
    if (open) { S.alert = null; renderPanel(); setTimeout(() => $('composer-input').focus(), 120); }
    render();
  }

  // The settings page takes the chats and conversation's place in the panel.
  function showSettings(on) {
    document.querySelector('.p-body').hidden = on;
    $('settings').hidden = !on;
    if (on) SettingsPage.open().catch((err) => window.butler.log(`settings: ${err.message}`));
  }
  SettingsPage.init({ onClose: () => showSettings(false) });
  $('open-settings').innerHTML = Icons.svg('gear', 15, 2);
  $('open-settings').onclick = () => showSettings(true);
  $('feed').dataset.hint = `Hold ${cfg.key} to talk, or type below.`;
  Devices.setOutput(cfg.audio.output);

  // ── wiring ───────────────────────────────────────────────────────────────
  window.butler.onPanel((open) => openPanel(open));
  window.butler.onState((s) => {
    Object.assign(S, s);
    if (S.pending.length) setTurnStatus('Waiting for your OK below', true);
    else if (turnRow && turnRow.status.classList.contains('needs')) setTurnStatus('Thinking');
    if (S.panel) renderPanel();
    render();
  });
  window.butler.onChime((kind) => Sounds.play(kind));
  window.butler.onSay((text) => Voice.say(text));
  window.butler.onShow(({ title, markdown }) => {
    feedAdd('card pane', `${title ? `<h3>${MD.esc(title)}</h3>` : ''}${MD.render(markdown)}`, { html: true });
  });
  window.butler.onAlert((a) => {
    S.alert = a;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => { S.alert = null; render(); }, 7000);
    $('alert-icon').innerHTML = Icons.svg(a.kind === 'needs' ? 'bell' : 'exclaim', 17, 2.1);
    $('alert-title').textContent = a.kind === 'needs' ? `${a.title} needs you` : a.title;
    $('alert-body').textContent = a.body || '';
    render();
  });
  window.butler.onEndConversation(() => Voice.endConversation());
  window.butler.onAgentEvent((ev) => {
    const a = ev.agent || {};
    if (ev.event === 'needs_input') feedAdd('note needs', `${a.name} needs you: ${ev.summary || ''}`);
    else if (ev.event === 'done') feedAdd('note', `${a.name} finished`);
    else if (ev.event === 'spawned') feedAdd('note', `Started ${a.name} (${a.cli}, ${a.model || 'default'})`);
    if (ev.event !== 'progress') refresh();
  });
  window.butler.onComputerEvent((ev) => {
    if (ev.event === 'done' || ev.event === 'failed') feedAdd('note', `On screen: ${ev.task.result || ev.event}`);
    if (ev.event !== 'action') refresh();
  });
  window.butler.onCaption((c) => {
    if (S.voice !== 'listening' && !S.convo) return;
    S.heard = c.text;
    Island.setHeard(c.text);
    if (c.final && c.text) feedAdd('bubble you', c.text);
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); tool('open', { target: a.href }); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.panel) openPanel(false); });
  $('live').onclick = () => openPanel(true);
  $('alert-open').onclick = () => openPanel(true);
  $('composer-send').innerHTML = Icons.svg('up', 16, 2.4);
  const input = $('composer-input');
  input.oninput = () => $('composer').classList.toggle('has-text', !!input.value.trim());
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    $('composer').classList.remove('has-text');
    beginTurn(text);
    Voice.sendText(text);
  };

  $('new-chat').innerHTML = Icons.svg('plus', 16, 2.2);
  $('new-chat').onclick = async () => {
    await window.butler.newChat();
    feedChat = null;
    feed.replaceChildren();
    await showChat(null);
    renderChats();
  };

  function wake(command) {
    Sounds.play('wake');
    S.quiet = false;
    S.convo = true;
    startListening('convo');
    Voice.startConversation(command || '');
  }
  window.butler.onWake(({ command }) => wake(command || ''));

  // Pause is an intercom. A press while Butler speaks only stops it: a tap
  // leaves it there, a hold puts everything away when released.
  let stopping = false;
  function quietDown() {
    clearTimeout(lingerTimer);
    S.linger = false;
    S.reply = '';
    Island.setReply('');
    setVoice('idle');
  }

  window.butler.onPtt(({ phase, kind, stop }) => {
    if (phase === 'down' && stop) {
      stopping = true;
      if (Voice.stop) Voice.stop();
      quietDown();
      return;
    }
    if (stopping) {
      if (phase !== 'up') return;
      stopping = false;
      if (kind === 'hold') { if (S.panel) openPanel(false); S.alert = null; quietDown(); }
      return;
    }
    if (phase === 'hold') { S.armed = false; Sounds.play('ptt'); render(); Voice.interrupt(); return; }
    if (phase === 'down') {
      S.quiet = true;
      S.armed = Island.view() !== 'wave';
      setVoice('listening');
      startListening('ptt');
      Voice.pttDown();
      return;
    }
    S.armed = false;
    stopListening();
    if (kind === 'tap') {
      S.linger = false;
      setVoice('idle');
      Voice.pttUp('tap');
      return;
    }
    Sounds.play('release');
    Voice.pttUp('hold');
  });

  // Dev screenshots: fixed sample states, no microphone or network needed.
  window.butler.onDevState((name) => {
    devWallpaper();
    Island.fakeLevel(name === 'listening' || name === 'wave' ? 2.4 : name === 'speaking' ? 2.8 : 1.2);
    if (name === 'panel') {
      S.panel = true;
      feedAdd('bubble you', 'Order me a G502 X from Amazon, same as last time.');
      feedAdd('bubble butler', 'On it. I found it for $79.99, arriving Monday. Want me to place the order?');
      // Sample chats for the screenshot, not real history.
      const h = 3600000;
      loadChats = async () => ([
        { id: 's1', title: 'Order me a G502 X from Amazon', current: true, updated: Date.now() },
        { id: 's2', title: 'What time is my flight tomorrow', updated: Date.now() - 2 * h },
        { id: 's3', title: 'Spawn a Fable agent on the parser', updated: Date.now() - 5 * h },
        { id: 's4', title: 'How much VRAM does the 5080 have', updated: Date.now() - 30 * h },
        { id: 's5', title: 'Open Steam', updated: Date.now() - 80 * h },
      ]);
      renderPanel();
    } else if (name === 'settings') {
      S.panel = true;
      showSettings(true);
    } else if (name === 'wave') {
      S.quiet = true; S.voice = 'listening'; Island.setWaveMode('listening');
    } else if (name === 'listening') {
      S.voice = 'listening'; Island.setWaveMode('listening');
      Island.setHeard('spawn a Fable agent that orchestrates Opus medium subagents on the parser');
    } else if (name === 'speaking') {
      S.voice = 'speaking'; Island.setWaveMode('speaking');
      Island.setHeard('what time is my flight tomorrow');
      Island.setReply('Your flight to Austin leaves at 7:40 AM from SFO, terminal 2. Leave by 5:50 to be safe.');
    } else if (name === 'alert') {
      S.alert = { kind: 'needs', title: 'lead-parser', body: 'Approve the schema migration?' };
      $('alert-icon').innerHTML = Icons.svg('bell', 17, 2.1);
      $('alert-title').textContent = 'lead-parser needs you';
      $('alert-body').textContent = 'Approve the schema migration?';
    } else if (name === 'live') {
      S.pending = [];
    }
    render();
  });

  // A stand-in desktop for dev screenshots, so the glass has something to bend.
  function devWallpaper() {
    const w = innerWidth, h = innerHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#1b3b6f'); bg.addColorStop(0.5, '#6a3d8f'); bg.addColorStop(1, '#e0785a');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    for (const [x, y, r, col] of [[120, 120, 220, '#39c6ff'], [620, 90, 180, '#ff5ea8'], [420, 520, 260, '#ffd166']]) {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, col + 'cc'); rg.addColorStop(1, col + '00');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }
    g.fillStyle = 'rgba(12,14,20,.92)'; g.beginPath(); g.roundRect(60, 150, 520, 400, 14); g.fill();
    g.font = '600 15px Consolas, monospace';
    const lines = ['$ herdr agent list', 'lead-parser   claude  blocked', 'opus-worker   claude  working', '', '> Refactor the tokenizer into its own module', '  Reading src/lexer.rs', '  Editing src/parser/mod.rs', '  Running cargo test ... 214 passed'];
    lines.forEach((l, i) => { g.fillStyle = i === 0 ? '#9ef' : i < 3 ? '#cfd6e4' : '#a9b3c4'; g.fillText(l, 84, 190 + i * 26); });
    g.font = '800 120px Inter Variable, sans-serif'; g.fillStyle = 'rgba(255,255,255,.9)'; g.fillText('BOFFY', 250, 130);
    const url = c.toDataURL('image/jpeg', 0.92);
    document.body.style.background = `url(${url}) 0 0 / ${w}px ${h}px`;
    Island.setBackdrop(url);
  }

  // ── voice session ────────────────────────────────────────────────────────
  Island.init();
  Island.onChange((next) => { if (next === 'panel') renderPanel(); });
  refresh();
  setInterval(refresh, 5000);

  let micTrack;
  try {
    micTrack = await Mic.init(cfg);
  } catch (err) {
    window.butler.log('mic: ' + err.message);
    feedAdd('note', 'No microphone');
    return;
  }
  Mic.setFeed('wake');
  syncFeed(true);

  const hooks = {
    onConnected: () => {},
    onDisconnected: (why) => window.butler.log('voice dropped: ' + why),
    onListening: (m) => { if (m === 'convo' && S.voice !== 'listening') { S.heard = ''; Island.setHeard('', 'Listening'); } setVoice('listening'); },
    onThinking: () => { setVoice('thinking'); beginTurn(); },
    onSpeaking: () => { setVoice('speaking'); if (Mic.feed() === 'wake') Mic.setFeed(null); },
    onSpeakingDone: () => {
      if (Voice.mode() === 'idle') { setVoice('idle'); Mic.setFeed('wake'); settle(); }
      else setVoice('listening');
    },
    onResponseDone: () => { endTurn(''); if (S.voice === 'thinking' && Voice.mode() === 'idle') { setVoice('idle'); settle(); } },
    onIdle: () => {
      S.convo = false;
      window.butler.captions('stop');
      Mic.setFeed('wake');
      if (S.voice !== 'speaking') { setVoice('idle'); settle(); }
    },
    // Realtime's own transcript: the fallback when live captions are off.
    onUserText: (t) => {
      if (turnRow) { if (turnRow.you.textContent === '…') turnRow.you.textContent = t; S.heard = t; Island.setHeard(t); }
      else if (cfg.captions === 'off' || !S.heard) { S.heard = t; Island.setHeard(t); feedAdd('bubble you', t); }
    },
    onButlerDelta: (d, id) => {
      if (id !== S.replyId) { S.replyId = id; S.reply = ''; }
      S.reply += d;
      Island.setReply(S.reply);
    },
    onButlerText: async (t) => { if (viewing) showChat(null); if (!endTurn(t)) feedAdd('bubble butler', t); await syncFeed(); if (S.panel) renderChats(); },
    onTool: (name) => {
      setTurnStatus(TOOL_STATUS[name] || 'Working on it');
      if (!S.reply) Island.setReply(TOOL_STATUS[name] || 'Working on it', { status: true });
    },
    onToolDone: (name, out) => { if (out && out.error) feedAdd('note', `${name}: ${out.error}`); },
    onError: (msg) => { endTurn('', null); feedAdd('note', msg.slice(0, 160)); Sounds.play('error'); S.reply = msg.slice(0, 90); Island.setReply(S.reply); setVoice('idle'); settle(); },
    onRemoteStream: (stream) => Island.setOutputStream(stream),
  };

  try { await Voice.init(cfg, micTrack, hooks); } catch (err) {
    window.butler.log('voice init: ' + err.message);
    feedAdd('note', 'Voice offline');
  }
})();
