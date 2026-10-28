// Butler: Electron main process. Owns the tools, the agent fleet, routines,
// computer-use tasks and the loopback control server; the dock window owns the
// microphone, the Realtime voice session and everything Josh sees.
const { app, BrowserWindow, ipcMain, screen, protocol, net, Tray, Menu, nativeImage, desktopCapturer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadConfig, userDir } = require('./src/config');
const { createSettings } = require('./src/settings');
const { createWinhost } = require('./src/winhost');
const { createLanes } = require('./src/lanes');
const { createPending } = require('./src/pending');
const { createHistory } = require('./src/history');
const { createChats } = require('./src/chats');
const { createRoutines } = require('./src/routines');
const { createHerdr } = require('./src/agents/herdr');
const { createFleet } = require('./src/agents/fleet');
const { createComputer } = require('./src/computer');
const { createDesktop } = require('./src/tools/desktop');
const { createTools } = require('./src/tools');
const { createFilesAgent } = require('./src/tools/files-agent');
const { createScreen } = require('./src/screen');
const { createControl } = require('./src/control');
const { mint } = require('./src/voice/session');
const { createTurns, frameLevels } = require('./src/voice/turns');
const { createSpeech } = require('./src/voice/speech');
const { buildInstructions } = require('./src/voice/instructions');
const { createSession, historyInput, liveInstructions } = require('./src/voice/live');
const { createWakewatch } = require('./src/voice/wakewatch');
const { createPorcupine } = require('./src/voice/porcupine');
const { createCaptions } = require('./src/voice/captions');
const { createGesture } = require('./src/gesture');
const { createRelay } = require('./src/relay');

const ROOT = __dirname;
const config = loadConfig();
const LOG = path.join(config.stateDir, 'butler.log');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* disk full */ } };

// One instance only: a second launch (Startup shortcut plus a manual run) would
// fight over the control port and the Pause key.
if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([
  { scheme: 'butler', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let dock = null;
let panelOpen = false;
let relay = null;

// ── UI bridge used by tools and background work ──────────────────────────────
// The dock renderer owns what is on screen; main only sends it intents.
const send = (channel, payload) => { if (dock && !dock.isDestroyed()) dock.webContents.send(channel, payload); };
const ui = {
  show: (title, markdown) => { send('show', { title, markdown }); if (relay) relay.emit({ type: 'card', title, markdown }); },
  chime: (kind) => send('chime', kind),
  say: (text) => send('say', text),
  alert: (alert) => send('alert', alert),
  endConversation: () => send('end-conversation'),
};

// ── services ─────────────────────────────────────────────────────────────────
const winhost = createWinhost({ log });
const lanes = createLanes(config);
const pending = createPending({ onChange: (list) => send('state', { pending: list }) });
const history = createHistory({ dir: config.stateDir, onChange: (recent) => send('state', { recent }) });
const routines = createRoutines({ winhost, say: ui.say, onChange: (list) => send('state', { routines: list }) });
const herdr = createHerdr({ bin: config.herdr.bin, session: config.herdr.session });
const desktop = createDesktop({ winhost, config, log });

// A background question is spoken, shown, and answered by voice or click.
async function askJosh(question, task) {
  const q = pending.ask('computer', question, `task ${task.id}`);
  ui.chime('attention');
  ui.say(`The computer task asks (${q.id}): ${question} Ask Josh briefly and pass his answer with answer_pending.`);
  return q.answer;
}

let lastAgents = [];
function onAgentEvent(ev) {
  if (relay && ev.event !== 'progress') relay.emit({ type: 'agent', event: ev.event, agent: ev.agent, summary: ev.summary });
  send('agent-event', ev);
  if (ev.event === 'needs_input') {
    ui.chime('needs');
    ui.alert({ kind: 'needs', title: ev.agent.name, body: ev.summary });
    if (config.agents.announce === 'voice') ui.say(`Agent ${ev.agent.name} needs Josh: ${ev.summary}. Tell him in one short sentence.`);
  } else if (ev.event === 'done' && ev.agent.visible === false) {
    ui.chime('done');
    ui.say(`Background agent ${ev.agent.name} finished. Result: ${String(ev.summary).slice(-800)} Tell Josh the outcome in one sentence and show paths in the dock if there are any.`);
  } else if (ev.event === 'done') {
    ui.chime('done');
  } else if (ev.event === 'failed') {
    ui.chime('error');
    ui.say(`Agent ${ev.agent.name} failed: ${String(ev.summary).slice(-400)} Tell Josh in one sentence.`);
  }
}

function onComputerEvent(ev) {
  if (relay && ev.event !== 'action') relay.emit({ type: 'computer', event: ev.event, task: ev.task, question: ev.question });
  send('computer-event', ev);
  if (ev.event === 'done') { ui.chime('done'); ui.say(`Computer task ${ev.task.id} finished: ${ev.task.result} Tell Josh in one sentence.`); }
  if (ev.event === 'failed') { ui.chime('error'); ui.say(`Computer task ${ev.task.id} stopped: ${ev.task.result} Tell Josh in one sentence.`); }
}

const fleet = createFleet({ herdr, config, lanes, emit: onAgentEvent, log });
const computer = createComputer({ lanes, winhost, config, emit: onComputerEvent, ask: askJosh });
const filesAgent = createFilesAgent({ lanes, desktop });
const eyes = createScreen({ winhost, lanes, config, log });
const tools = createTools({ config, desktop, winhost, routines, fleet, computer, lanes, filesAgent, screen: eyes, pending, ui, history, log });

// Live context for the voice model, gathered in parallel with a hard deadline
// so pressing Pause never waits on a slow herdr.
async function liveContext() {
  const within = (p, ms, fallback) => Promise.race([p.catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const [foreground, agents] = await Promise.all([
    within(winhost.call('foreground'), 300, null),
    within(fleet.list().then((a) => (lastAgents = a)), 400, lastAgents),
  ]);
  return {
    time: new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }),
    foreground, agents, routines: routines.list(), tasks: computer.list(), pending: pending.list(),
  };
}

// ── dock window ──────────────────────────────────────────────────────────────
// One transparent window at the top centre of the primary display, big enough
// for the fully expanded panel. The island morphs inside it with CSS springs,
// so no native resize ever animates. Clicks pass through everywhere except the
// glass itself, and the window is hidden outright whenever the island is gone,
// so nothing sits over a fullscreen game.
function dockBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const { stageWidth: w, stageHeight: h } = config.dock;
  return { x: Math.round(area.x + (area.width - w) / 2), y: area.y, width: w, height: h };
}

function createDock() {
  dock = new BrowserWindow({
    ...dockBounds(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      backgroundThrottling: false, // the voice session and wake audio run while hidden
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Invisible to screenshots: the computer-use agent never sees the dock, and
  // the desktop capture behind the glass never contains the glass itself.
  dock.setContentProtection(true);
  dock.setAlwaysOnTop(true, 'screen-saver');
  dock.setIgnoreMouseEvents(true, { forward: true });
  dock.loadURL('butler://app/renderer/dock.html');
  // The dock never navigates or opens windows; links go to the real browser.
  dock.webContents.on('will-navigate', (e) => e.preventDefault());
  dock.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dock.on('blur', () => { if (panelOpen && config.dock.hideOnBlur) send('panel', false); });
  screen.on('display-metrics-changed', () => dock.setBounds(dockBounds()));
}

// The glass refracts a screenshot of the desktop behind the window, since no
// web page can see past its own window. Captured on demand, never on the
// Pause path: the island shows first and the refraction fades in.
async function captureBackdrop() {
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor;
  const b = dock.getBounds();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
  });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src) return null;
  const crop = src.thumbnail.crop({
    x: Math.round((b.x - display.bounds.x) * sf), y: Math.round((b.y - display.bounds.y) * sf),
    width: Math.round(b.width * sf), height: Math.round(b.height * sf),
  });
  return `data:image/jpeg;base64,${crop.toJPEG(88).toString('base64')}`;
}

// ── tray: the one place to quit, restart or mute ─────────────────────────────
let tray = null;
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
  tray.setToolTip('Butler');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open dock', click: () => send('panel', true) },
    { label: 'Stop all routines', click: () => routines.stop('all') },
    { label: 'Cancel computer tasks', click: () => computer.cancel('all') },
    { type: 'separator' },
    { label: 'Open settings folder', click: () => winhost.call('open', { target: path.dirname(config.stateDir) }).catch(() => {}) },
    { label: 'Open log', click: () => winhost.call('open', { target: LOG }).catch(() => {}) },
    { label: 'Restart Butler', click: () => { app.relaunch(); app.exit(0); } },
    { label: 'Quit Butler', click: () => app.quit() },
  ]);
  tray.on('click', () => send('panel', !panelOpen));
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

// ── wake word ────────────────────────────────────────────────────────────────
let wake = null;
function startWake() {
  const onWake = (hit) => send('wake', hit);
  if (config.wake.engine === 'porcupine') {
    wake = createPorcupine({ config, onWake, log });
    wake.start().then((ok) => { if (!ok) log('porcupine unavailable; wake word off'); });
  } else if (config.wake.engine === 'openai') {
    wake = createWakewatch({ config, onWake, log });
    wake.start();
  }
}

// ── control server: Pause and hooks ──────────────────────────────────────────
// Pause: hold to talk with no window, tap to open or close the dock.
// A press while Butler speaks stops the speech, and a tap does nothing more.
// AutoHotkey reports raw down/up; the gesture is read here.
let speaking = false;
let pressStopped = false;
const gesture = createGesture({
  tapMs: config.hotkeys.tapMs,
  onHoldStart: () => { pressStopped = speaking; send('ptt', { phase: 'down', stop: pressStopped }); },
  onHoldConfirmed: () => send('ptt', { phase: 'hold' }),
  onHoldEnd: ({ held }) => { log(`pause: hold ${held}ms`); send('ptt', { phase: 'up', kind: 'hold' }); },
  onTap: ({ held }) => {
    log(`pause: tap ${held}ms${pressStopped ? ', stopped speech' : ''}`);
    send('ptt', { phase: 'up', kind: 'tap' });
    if (pressStopped) return { focus: false };
    send('panel', !panelOpen);
    return { focus: !panelOpen };
  },
});
ipcMain.on('speaking', (e, on) => { speaking = !!on; });

const hookSeen = new Map();
function startControl() {
  createControl({
    port: config.hotkeys.port,
    stateDir: config.stateDir,
    log,
    routes: {
      '/key/ptt-down': () => { gesture.down(); },
      // The reply tells AutoHotkey to hand focus to the dock after a tap opens it.
      '/key/ptt-up': () => {
        const r = gesture.up();
        return { ok: true, focus: !!(r && r.focus) };
      },
      '/key/dock': () => { send('panel', !panelOpen); return { ok: true, focus: !panelOpen }; },
      // Claude Code Notification hooks: exact "needs you" signals that back up
      // herdr's screen detection. Deduped per cwd for 15s.
      '/event': (e) => {
        const key = `${e.source}:${e.cwd || ''}`;
        if (Date.now() - (hookSeen.get(key) || 0) < 15000) return;
        hookSeen.set(key, Date.now());
        onAgentEvent({ type: 'agent', event: 'needs_input', agent: { name: path.basename(e.cwd || e.source || 'agent'), cli: e.source, status: 'blocked' }, summary: e.message || 'waiting' });
      },
    },
  });
}

// ── captions: what Butler hears, while Josh is still talking ─────────────────
const captions = createCaptions({ config, log, onCaption: (c) => send('caption', c) });

// ── IPC from the dock ────────────────────────────────────────────────────────
// GPT-Live needs an OpenAI key; without one the dock falls back to turns.
const voiceEngine = config.voice.engine === 'live' && !process.env.OPENAI_API_KEY ? 'turns' : config.voice.engine;
if (voiceEngine !== config.voice.engine) log('voice: OPENAI_API_KEY is not set, so the turns engine answers');
ipcMain.handle('config', () => ({
  dock: config.dock, voice: { ...config.voice, engine: voiceEngine }, captions: captions.engine, audio: config.audio, key: config.hotkeys.key,
  wake: { engine: config.wake.engine, speechGateRms: config.wake.speechGateRms },
}));
ipcMain.handle('mint', async () => mint(config, buildInstructions(config, await liveContext()), tools.schemas()));
// Turn-based voice (voice.engine "turns"): any model lane, speech made here.
const chats = createChats({ dir: config.stateDir, ttlMs: (config.voice.chatGapMinutes || 180) * 60000 });
const turns = createTurns({ config, lanes, tools, chats, context: liveContext, emit: (e) => { if (e.type === 'tool') log(`voice tool: ${e.name}`); send('voice-event', e); } });
const speech = createSpeech({ config, log });
const timed = async (label, p) => { const t = Date.now(); try { return await p; } finally { log(`${label}: ${Date.now() - t}ms`); } };
// The clip's loudness in the mic tap's 2048-sample frames (median and loudest),
// the numbers the dock's wave scales against.
function clipLevel(pcm) {
  const rms = frameLevels(pcm);
  return rms.length ? `median ${rms[rms.length >> 1].toFixed(4)} max ${rms[rms.length - 1].toFixed(4)}` : 'empty';
}
ipcMain.handle('voice-turn', (e, payload) => {
  if (payload && payload.pcm) log(`mic level: ${clipLevel(payload.pcm)}`);
  return timed('voice turn', turns.run(payload));
});
// GPT-Live (voice.engine "live"): the session, its delegated requests, and the exchanges it spoke.
ipcMain.handle('live-session', async (e, sdp) => timed('live session', createSession(config, {
  sdp,
  instructions: liveInstructions(config, await liveContext()),
  input: historyInput(chats.current(), { turns: config.voice.historyTurns }),
})));
ipcMain.handle('live-delegate', (e, text) => timed('delegation', turns.run({ text: String(text || '') }, { delegated: true })));
ipcMain.handle('live-record', (e, { heard, answer, shown }) => { chats.record(String(heard), String(answer), shown || ''); });
ipcMain.handle('speak', (e, text) => timed('speech', speech.synth(String(text || '').slice(0, 2000))));
ipcMain.handle('chats', () => chats.list());
ipcMain.handle('chat', (e, id) => chats.get(id));
ipcMain.handle('new-chat', () => chats.startNew());
ipcMain.handle('instructions', async () => buildInstructions(config, await liveContext()));
ipcMain.handle('tool', (e, { name, args }) => tools.execute(name, args || {}));
async function snapshot() {
  return {
    agents: await fleet.list().catch(() => lastAgents), routines: routines.list(), tasks: computer.list(),
    pending: pending.list(), recent: history.recent(),
  };
}
ipcMain.handle('snapshot', snapshot);

// ── settings page ────────────────────────────────────────────────────────────
// Saving restarts Butler so every service picks the change up, and restarts
// the key script through its Startup shortcut when the talk key changed.
const settings = createSettings({ config, dir: userDir() });
settings.writeKeyFile();
ipcMain.handle('settings', () => settings.read());
ipcMain.handle('settings-save', (e, s) => {
  const { keyChanged } = settings.save(s || {});
  log(`settings saved${keyChanged ? `, talk key ${config.hotkeys.key}` : ''}; restarting`);
  if (keyChanged) {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'butler-keys.lnk');
    shell.openPath(lnk).then((err) => { if (err) log(`key script restart: ${err}`); });
  }
  setTimeout(() => { app.relaunch(); app.exit(0); }, 300);
  return { ok: true };
});
ipcMain.handle('edge-voices', async () => {
  const { MsEdgeTTS } = require('msedge-tts');
  try { return (await new MsEdgeTTS().getVoices()).map((v) => v.ShortName).filter((n) => /^en-/.test(n)).sort(); } catch { return []; }
});

// ── phone relay (remote/ on Vercel) ──────────────────────────────────────────
relay = createRelay({ config, tools, schemas: tools.schemas, pending, lanes, winhost, snapshot, log });
ipcMain.handle('answer', (e, { id, answer }) => pending.answer(id, answer));
ipcMain.handle('backdrop', () => (SHOT ? Promise.resolve(null) : captureBackdrop()).catch((err) => { log(`backdrop: ${err.message}`); return null; }));
ipcMain.on('visible', (e, on) => {
  if (!dock) return;
  if (on && !dock.isVisible()) { dock.showInactive(); dock.setAlwaysOnTop(true, 'screen-saver'); }
  if (!on && dock.isVisible()) dock.hide();
});
ipcMain.on('panel-state', (e, open) => {
  panelOpen = !!open;
  if (panelOpen) dock.focus();
  else if (dock.isFocused()) dock.blur();
});
// Click-through everywhere but the glass.
ipcMain.on('hit', (e, over) => { if (dock) dock.setIgnoreMouseEvents(!over, { forward: true }); });
ipcMain.on('captions', (e, { action, mode }) => (action === 'start' ? captions.start(mode) : captions.stop()));
ipcMain.on('caption-audio', (e, buf) => captions.audio(buf));
ipcMain.on('wake-audio', (e, buf) => { if (wake && wake.append) wake.append(buf); });
ipcMain.on('log', (e, m) => log(`[dock] ${m}`));

// Dev: BUTLER_SHOT=out.png opens the panel with sample state, saves a
// screenshot and quits. Lets the dock be checked without a Windows desktop.
const SHOT = process.env.BUTLER_SHOT || '';
if (SHOT) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// Sample states for the dev screenshot: BUTLER_SHOT_STATE=panel|wave|listening|speaking|live|alert.
function devShot() {
  dock.webContents.once('did-finish-load', () => setTimeout(async () => {
    dock.setContentProtection(false);
    dock.showInactive();
    send('state', require('./test/fixtures/dock-state.json'));
    send('dev-state', process.env.BUTLER_SHOT_STATE || 'panel');
    if ((process.env.BUTLER_SHOT_STATE || 'panel') === 'panel') {
      send('show', { title: 'Order summary', markdown: '- **Logitech G502 X**, $79.99\n- Ships Monday to your saved address\n- [View cart](https://www.amazon.com/cart)' });
    }
    await new Promise((r) => setTimeout(r, 2600));
    fs.writeFileSync(SHOT, (await dock.webContents.capturePage()).toPNG());
    app.exit(0);
  }, 600));
}

app.whenReady().then(() => {
  protocol.handle('butler', (req) => {
    const url = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createDock();
  if (SHOT) return devShot();
  createTray();
  startControl();
  startWake();
  fleet.startWatching();
  relay.start();
  log('butler up');
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  fleet.stopWatching();
  routines.stop('all');
  relay.stop();
  computer.cancel('all');
  if (wake) wake.stop();
  winhost.stop();
});
