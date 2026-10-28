// GPT-Live sessions (voice.engine "live"). The dock sends its WebRTC offer;
// this posts it with Butler's live prompt and the current chat, and returns
// the SDP answer. The API key never leaves the main process.
const { contextBlock } = require('./instructions');

const URL = 'https://api.openai.com/v1/live/sessions';

// The live model talks; anything that needs Butler's tools is delegated to
// the delegate lane. The three policy headings are the ones OpenAI's
// prompting guide asks GPT-Live prompts to keep.
function liveInstructions(config, ctx) {
  return `${config.persona}

Josh talks to you with push-to-talk: he holds a key while he speaks and lets go when he is done. Silence after his words means it is your turn, so answer right away. Keep listening while he pauses mid-sentence.

Speaking style: one short sentence whenever that is enough, two at most. Plain spoken English, numbers the way people say them. Never read lists, links, code or file paths aloud.

Backchannel policy: Do not backchannel. Josh speaks in one burst.

Interruption policy: Stop speaking when Josh interrupts. Listen to what he says.

Delegation policy:
Backend tools:
- The PC: open apps, sites and files; type and press keys; switch windows; volume and music.
- The screen: see what is on it, and click or drive any app.
- Search: the web for anything current, and Josh's files.
- Agents: start Claude or Codex coding agents in herdr, and check on or answer the ones running.
- Long jobs on screen: sign-ups, orders, forms, app menus.
- Routines, PowerShell commands, and the dock, which shows detail Josh can read.

Delegate to the backend when:
- Josh asks you to do anything on the PC, look at the screen ("this", "that error"), or start or check an agent.
- The answer depends on anything current or checkable: news, prices, weather, today's facts, his files.
- The answer needs steps, a list, a link or code; the backend puts it in the dock.
- A correction changes work already requested.

Do not delegate to the backend when:
- General knowledge answers it: math, unit conversions, definitions, facts that do not change.
- Josh is chatting, thanks you, or asks you to repeat something already said.

When you delegate, say two or three words such as "On it." and wait for the result. Do not guess the result. Say an action is done only after the backend says so.${ctx ? `\n\n${contextBlock(ctx)}` : ''}`;
}

// The current chat as startup history, newest exchanges kept. GPT-Live takes
// up to 128 messages and 8,192 tokens; maxChars keeps well under the tokens.
function historyInput(chat, { turns = 20, maxChars = 24000 } = {}) {
  if (!chat) return [];
  const clip = (s) => String(s || '').slice(0, 1000);
  const out = [];
  let chars = 0;
  for (const t of chat.turns.slice(-Math.min(turns, 64)).reverse()) {
    const pair = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: clip(t.heard) }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: clip(t.answer) }] },
    ];
    chars += clip(t.heard).length + clip(t.answer).length;
    if (chars > maxChars) break;
    out.unshift(...pair);
  }
  return out;
}

function sessionBody(config, { sdp, instructions, input }) {
  const live = config.voice.live;
  return {
    session: {
      model: live.model,
      instructions,
      input,
      audio: { output: { voice: live.voice } },
      delegation: { type: 'client' },
    },
    transport: { type: 'webrtc', sdp },
  };
}

// OpenAI's 401 message quotes part of the key, so key-like strings are cut.
const scrub = (s) => String(s).replace(/sk-[A-Za-z0-9_*-]+/g, 'sk-…');

async function createSession(config, { sdp, instructions, input }, { fetchImpl = fetch, env = process.env } = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set. Put it in %APPDATA%\\Butler\\.env.');
  const res = await fetchImpl(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody(config, { sdp, instructions, input })),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`live session ${res.status}: ${scrub((data.error && data.error.message) || '').slice(0, 300)}`);
  return { id: data.session.id, sdp: data.transport.sdp };
}

module.exports = { createSession, sessionBody, historyInput, liveInstructions };
