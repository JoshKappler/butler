# CLAUDE.md: Butler

Voice and desktop agent for Josh's Windows 11 PC (BOFFY). Electron app; see `README.md`
for what it does and how the pieces fit.

## Layout

- `main.js`: Electron main. Wires every service, the dock window, the tray, and the
  loopback control server (`src/control.js`, port 47113, token in `%APPDATA%\Butler\state\token`).
- `renderer/`: the dock, a Dynamic Island. `dock.js` picks the view (off, live, alert,
  voice, panel) and fills the panel (chats from `src/chats.js` on the left, the
  conversation on the right); `island.js` owns shape, click-through and the siriwave wave;
  `glass.js` draws the liquid glass (a WebGL port of BarredEwe/LiquidGlass) over a desktop capture; `voice-live.js` the GPT-Live session,
  `voice.js` the WebRTC Realtime one and `voice-turns.js` the turn-based one (same surface, picked by `voice.engine`);
  `mic.js` the mic tap that feeds captions, the wake watcher, or a turn's recording.
  `settings.js` is the panel's settings page (gear by Chats): audio devices (`devices.js`), voice
  provider and voices, API keys and the talk key; `src/settings.js` saves it to `%APPDATA%\Butler`
  (`config.json`, `.env`, `state\ptt-key`) and Butler restarts.
- `src/gesture.js`: Pause hold / tap. `src/voice/captions.js`: live captions
  (Muse Voice Transcribe or gpt-live-transcribe). `src/lanes.js`: provider-agnostic model
  lanes; `src/tools/files-agent.js` runs on the `files` lane. `src/voice/live.js` opens GPT-Live
  sessions. `src/voice/turns.js` runs a turn on the `voice` lane, or a GPT-Live delegation on the `delegate` lane, with the tools from `src/tools/agent-tools.js`, and
  `src/voice/speech.js` speaks the answer.
- `src/tools/`: the voice model's tools. `index.js` holds schemas and handlers; the
  schema text is prompt, so keep it short and exact.
- `src/computer.js`: gpt-6-astra computer-use loop over the Responses `computer` tool.
- `src/screen.js`: `look` (screen or focused-window capture, attached to the voice
  session as an image) and `mouse` (targets located by the computer model).
- Claude calls go through the official `@anthropic-ai/sdk` (lane kind `anthropic`), never an
  OpenAI-compatible shim.
- `src/agents/`: herdr CLI wrapper, the fleet (spawn, read, tell, needs-you detection),
  and recipes (orchestrate, mole_animate, model_3d, research).
- `src/relay.js` + `remote/`: the phone. `remote/` is a Vercel app (plain functions,
  Upstash Redis over REST, no dependencies); `relay.js` is the PC side that polls it.
  `remote/public/md.js` is a copy of `renderer/md.js`: keep them identical.
- `src/routines.js`: repeating actions with jittered timing (anti-AFK mouse).
- `win/`: `winhost.ps1` + `ButlerHost.cs` (input, screenshots, windows), `butler-keys.ahk`
  (the talk key only, read from `state\ptt-key`), `install.ps1`, Claude hook.

## Rules

- `npm test` must pass. Tests run anywhere; nothing in them needs Windows.
- `win/ButlerHost.cs` must compile at C# 5 (Windows PowerShell `Add-Type`). Check with
  `mcs -langversion:5 -target:library -r:System.Drawing.dll -r:System.Windows.Forms.dll win/ButlerHost.cs`.
- Model ids live in `config.default.json` (`voice`, `lanes`, `captions`), never in code.
- UI changes: check them with `BUTLER_SHOT=out.png BUTLER_SHOT_STATE=<panel|settings|listening|speaking|alert|live> xvfb-run -a npx electron --no-sandbox .`
  and look at the image before committing.
- Keys come from `.env` (repo root or `%APPDATA%\Butler\.env`). Never write a key into config or code.
- Anything that spends money, sends messages, or deletes must pass through Josh: the
  computer loop's `ask_josh`, the PowerShell approval gate, or a pending question.
- Speed is the feature. Do not add a round trip to the Pause path beyond the hear lane's transcript; gather context in
  parallel with deadlines like `liveContext()` does.
