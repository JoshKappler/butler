// Turn-based voice that works on any model lane. The dock records while Pause
// is held and hands over PCM; the hear lane transcribes it, and the voice lane
// answers the transcript with the same tools as the Realtime session. The
// voice lane never gets the audio: given audio plus a screenshot, it once
// rewrote the question to fit the screen.
const { buildInstructions } = require('./instructions');
const { agentTools } = require('../tools/agent-tools');
const { createChats } = require('../chats');

const REPLY_FORMAT = `# Reply format
Your reply is read aloud by a speech engine, so write only what should be heard. Write these lines:
A: your spoken answer
DOCK: only when there is detail to read (steps, lists, links, code): markdown on the lines after DOCK:. It goes in the dock; this replaces the show tool.
If Josh's words hold no clear request, write the A: line with nothing after it.`;

const BACKEND_NOTE = `# You are the backend
Butler's live voice model is talking with Josh and handed you this request. Do the work with your tools. Your A: line goes back to the voice model, which tells Josh in its own words, so give the facts and the outcome. It has already told him you are on it.`;

// A 16-bit mono PCM buffer as a WAV file.
function wav(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// RMS of each 2048-sample frame of a PCM16 clip, quietest first.
function frameLevels(pcm) {
  const s = new Int16Array(pcm);
  const rms = [];
  for (let i = 0; i + 2048 <= s.length; i += 2048) {
    let sum = 0;
    for (let j = i; j < i + 2048; j++) sum += (s[j] / 32768) ** 2;
    rms.push(Math.sqrt(sum / 2048));
  }
  return rms.sort((a, b) => a - b);
}

// Speech peaks near 0.1 and a dead mic sits near 0.0003. Given a silent clip,
// the hear lane once made up "and look for the next thing".
const SILENT_RMS = 0.004;
const silent = (pcm) => !(frameLevels(pcm).pop() >= SILENT_RMS);

function parseReply(text) {
  const [said, dock = ''] = text.split(/^\s*DOCK:/m);
  const a = /^\s*A:\s*([\s\S]*)$/m.exec(said);
  return { answer: (a ? a[1] : said).trim(), dock: dock.trim() };
}

function createTurns({ config, lanes, tools, context, chats, emit = () => {}, now = Date.now }) {
  chats = chats || createChats({ ttlMs: (config.voice.chatGapMinutes || 180) * 60000, now });
  const exchange = (r) => `Josh: ${r.heard}\nButler: ${r.answer}${r.shown ? `\n(In the dock: ${r.shown.slice(0, 1500)})` : ''}`;
  const tail = () => {
    const chat = chats.current();
    return chat ? `\n\n# This conversation so far\n${chat.turns.slice(-(config.voice.historyTurns || 20)).map(exchange).join('\n')}` : '';
  };

  async function hear({ pcm, rate, text }) {
    if (text) return text;
    if (silent(pcm)) return '';
    const b64 = wav(Buffer.from(pcm), rate).toString('base64');
    const msg = lanes.audioMessage('hear', 'Transcribe this recording exactly. Reply with the words only. If there is no speech, reply with nothing.', b64);
    if (!msg) throw new Error('no lane can hear audio: point lanes.hear at a gemini provider');
    return (await lanes.turn('hear', { messages: [msg], maxTokens: 400 })).text.trim();
  }

  // payload: { pcm: ArrayBuffer of PCM16, rate } or { text }. Returns { heard, answer, dock? }.
  // delegated: a GPT-Live handoff, answered on the delegate lane; the live engine records it once spoken.
  async function run(payload, { delegated = false } = {}) {
    const [heard, ctx] = await Promise.all([hear(payload), context()]);
    if (!heard) return { heard: '', answer: '' };
    const reply = await lanes.agent(delegated ? 'delegate' : 'voice', {
      instructions: `${buildInstructions(config, ctx)}\n\n${REPLY_FORMAT}${delegated ? `\n\n${BACKEND_NOTE}` : ''}${tail()}`,
      task: heard,
      // show would cost a second model call; the reply's DOCK section does its job.
      tools: agentTools({ schemas: tools.schemas, execute: tools.execute, exclude: ['show'], onResult: (name, args, out) => emit({ type: 'tool-done', name, out }) }),
      onStep: (c) => emit({ type: 'tool', name: c.name }),
      maxSteps: 6,
    });
    const parsed = parseReply(reply);
    const out = { heard, answer: parsed.answer };
    if (parsed.dock) { out.dock = parsed.dock; await tools.execute('show', { markdown: parsed.dock }); }
    if (out.answer && !delegated) chats.record(out.heard, out.answer, parsed.dock);
    return out;
  }

  return { run };
}

module.exports = { createTurns, wav, parseReply, frameLevels };
