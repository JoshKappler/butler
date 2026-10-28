// Mints a short-lived Realtime client secret for the dock's WebRTC session.
// The real API key never leaves the main process.
function sessionBody(config, instructions, tools) {
  const v = config.voice;
  const session = {
    type: 'realtime',
    model: v.model,
    instructions,
    output_modalities: ['audio'],
    tools,
    tool_choice: 'auto',
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: v.transcribeModel, language: 'en' },
        // Push-to-talk is the resting mode: nothing is a turn until Pause is released.
        turn_detection: null,
      },
      output: { voice: v.voice },
    },
  };
  if (v.reasoningEffort) session.reasoning = { effort: v.reasoningEffort };
  return { expires_after: { anchor: 'created_at', seconds: 600 }, session };
}

async function mint(config, instructions, tools, fetchImpl = fetch) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set. Put it in .env next to package.json or in %APPDATA%\\Butler\\.env.');
  const res = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionBody(config, instructions, tools)),
  });
  if (!res.ok) throw new Error(`client_secrets ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return { clientSecret: data.value, model: config.voice.model };
}

module.exports = { mint, sessionBody };
