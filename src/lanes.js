// Model lanes: every side job Butler runs (the "needs you?" check, web search,
// the file-search subagent, computer use) names a lane, and config maps the
// lane to a provider and model. Swapping Muse Spark, Gemini Flash, Haiku or a
// GPT model in is a one-line config change.
//
// Four wire formats cover every provider we use:
//   responses: OpenAI Responses API (web search and computer use)
//   gemini:    Google's generateContent (audio in, Google Search grounding)
//   chat:      OpenAI-compatible /chat/completions (Meta, Gemini, OpenAI)
//   anthropic: Claude through the official SDK's Messages API

// Claude models that take the server-side refusal fallback (see the Claude API docs).
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)$/;

function dataUrlParts(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) throw new Error('images must be base64 data URLs');
  return { media_type: m[1], data: m[2] };
}

function createLanes(config, { fetchImpl = fetch, env = process.env, anthropicFactory } = {}) {
  const claudeClients = new Map();
  function claude(key) {
    if (!claudeClients.has(key)) {
      const make = anthropicFactory || ((apiKey) => new (require('@anthropic-ai/sdk').default)({ apiKey }));
      claudeClients.set(key, make(key));
    }
    return claudeClients.get(key);
  }

  function resolve(name) {
    const lane = config.lanes[name];
    if (!lane) throw new Error(`no lane "${name}" in config.lanes`);
    const provider = config.providers[lane.provider];
    if (!provider) throw new Error(`lane ${name}: unknown provider "${lane.provider}"`);
    const key = env[provider.keyEnv];
    if (!key) throw new Error(`lane ${name}: ${provider.keyEnv} is not set`);
    return { ...lane, ...provider, key, name };
  }

  async function post(url, key, body, timeoutMs, headers = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const auth = url.includes('generativelanguage.googleapis.com') ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${url.split('/').slice(2, 3)} ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // Raw Responses call, for the computer-use loop and web search.
  async function responses(laneName, body, { timeoutMs = 60000 } = {}) {
    const l = resolve(laneName);
    if (l.kind !== 'responses') throw new Error(`lane ${laneName} needs a responses provider`);
    return post(l.url, l.key, { model: l.model, ...(l.params || {}), ...body }, timeoutMs, l.headers);
  }

  // generateContent with Butler's messages mapped to Gemini contents. A message
  // that already has parts (a model turn echoed back, audio, images) passes as is.
  async function gemini(l, { instructions, messages, tools = [], maxTokens, extraTools = [], final = false }, timeoutMs) {
    const body = {
      contents: messages.map((m) => (m.parts ? m : {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content,
      })),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024), ...(l.thinking ? { thinkingConfig: { thinkingLevel: l.thinking } } : {}) },
      ...(l.params || {}),
    };
    if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };
    const decls = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
    body.tools = [...extraTools, ...(decls.length ? [{ functionDeclarations: decls }] : [])];
    if (!body.tools.length) delete body.tools;
    // The last step keeps the declarations but forbids calls, so the model has to answer in words.
    if (final && decls.length) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    return post(`${l.url}/${l.model}:generateContent`, l.key, body, timeoutMs, l.headers);
  }

  function geminiResult(raw) {
    const content = (raw.candidates && raw.candidates[0] && raw.candidates[0].content) || { role: 'model', parts: [] };
    const parts = content.parts || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    const calls = parts.filter((p) => p.functionCall)
      .map((p, i) => ({ id: p.functionCall.id || `call${i}`, name: p.functionCall.name, args: p.functionCall.args || {} }));
    return { text, calls, raw, content };
  }

  // One turn, normalized: { text, calls: [{id, name, args}], raw }.
  async function turn(laneName, { instructions, messages, tools = [], maxTokens = 800, previous, final }, { timeoutMs = 45000 } = {}) {
    const l = resolve(laneName);
    if (l.kind === 'gemini') return geminiResult(await gemini(l, { instructions, messages, tools, maxTokens, final }, timeoutMs));
    if (l.kind === 'anthropic') {
      const body = {
        model: l.model,
        // Adaptive thinking is on by default on current Claude models and
        // counts against max_tokens, so leave it room.
        max_tokens: Math.max(maxTokens, 4096),
        messages,
        output_config: { effort: l.effort || 'low' },
        ...(l.params || {}),
      };
      if (instructions) body.system = instructions;
      if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      if (FALLBACK_MODELS.test(l.model) && l.fallbacks !== false) {
        body.betas = ['server-side-fallback-2026-07-01'];
        body.fallbacks = 'default';
      }
      const raw = await claude(l.key).beta.messages.create(body, { timeout: timeoutMs });
      if (raw.stop_reason === 'refusal') return { text: 'Claude declined that request.', calls: [], raw };
      const text = raw.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const calls = raw.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, calls, raw };
    }
    if (l.kind === 'responses') {
      const body = { model: l.model, instructions, input: messages, max_output_tokens: maxTokens, ...(l.params || {}) };
      if (tools.length) body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      if (l.reasoning) body.reasoning = { effort: l.reasoning };
      if (previous) body.previous_response_id = previous;
      const raw = await post(l.url, l.key, body, timeoutMs, l.headers);
      const calls = (raw.output || []).filter((o) => o.type === 'function_call')
        .map((o) => ({ id: o.call_id, name: o.name, args: safeJson(o.arguments) }));
      return { text: responsesText(raw), calls, raw };
    }
    const body = {
      model: l.model,
      messages: instructions ? [{ role: 'system', content: instructions }, ...messages] : messages,
      max_tokens: maxTokens,
      ...(l.params || {}),
    };
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const raw = await post(l.url, l.key, body, timeoutMs, l.headers);
    const msg = (raw.choices && raw.choices[0] && raw.choices[0].message) || {};
    const calls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) }));
    return { text: (msg.content || '').trim(), calls, raw, message: msg };
  }

  // Plain question, plain answer.
  async function ask(laneName, instructions, input, opts = {}) {
    const r = await turn(laneName, { instructions, messages: [{ role: 'user', content: input }], maxTokens: opts.maxTokens || 300 }, opts);
    return r.text;
  }

  // A small tool-using agent. tools: [{ name, description, parameters, run(args) }].
  // Works the same on every wire format; returns the final text. task is a
  // string or a message from imageMessage / audioMessage.
  async function agent(laneName, { instructions, task, tools, maxSteps = 8, onStep = () => {} }) {
    const l = resolve(laneName);
    const first = typeof task === 'string' ? { role: 'user', content: task } : task;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const runAll = (calls) => Promise.all(calls.map(async (c) => {
      onStep(c);
      const t = byName[c.name];
      let out;
      try { out = t ? await t.run(c.args || {}) : { error: `unknown tool ${c.name}` }; } catch (err) { out = { error: err.message }; }
      return { c, out: JSON.stringify(out).slice(0, 8000) };
    }));

    if (l.kind === 'responses') {
      let r = await turn(laneName, { instructions, messages: [first], tools });
      for (let step = 0; step < maxSteps && r.calls.length; step++) {
        const results = await runAll(r.calls);
        r = await turn(laneName, {
          instructions, tools, previous: r.raw.id,
          messages: results.map(({ c, out }) => ({ type: 'function_call_output', call_id: c.id, output: out })),
        });
      }
      return r.text || 'No answer.';
    }

    if (l.kind === 'gemini') {
      const messages = [first];
      for (let step = 0; step <= maxSteps; step++) {
        const r = await turn(laneName, { instructions, messages, tools, final: step === maxSteps });
        if (!r.calls.length) return r.text || 'No answer.';
        // The model turn goes back verbatim so its thought signatures survive.
        messages.push(r.content);
        const results = await runAll(r.calls);
        const parts = results.map(({ c, out }) => ({ functionResponse: { id: c.id, name: c.name, response: { result: out } } }));
        if (step === maxSteps - 1) parts.push({ text: 'No tool calls are left. Answer now with what you have.' });
        messages.push({ role: 'user', parts });
      }
      return 'Ran out of steps.';
    }

    if (l.kind === 'anthropic') {
      const messages = [first];
      for (let step = 0; step <= maxSteps; step++) {
        const r = await turn(laneName, { instructions, messages, tools: step < maxSteps ? tools : [] });
        if (!r.calls.length) return r.text || 'No answer.';
        // The whole assistant turn goes back unchanged (thinking blocks included),
        // and every tool result rides in one user message.
        messages.push({ role: 'assistant', content: r.raw.content });
        const results = await runAll(r.calls);
        messages.push({ role: 'user', content: results.map(({ c, out }) => ({ type: 'tool_result', tool_use_id: c.id, content: out })) });
      }
      return 'Ran out of steps.';
    }

    const messages = [first];
    for (let step = 0; step <= maxSteps; step++) {
      const r = await turn(laneName, { instructions, messages, tools: step < maxSteps ? tools : [] });
      if (!r.calls.length) return r.text || 'No answer.';
      messages.push({ role: 'assistant', content: r.message.content || null, tool_calls: r.message.tool_calls });
      for (const { c, out } of await runAll(r.calls)) messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
    return 'Ran out of steps.';
  }

  // A user message carrying one image, in the lane's wire format.
  function imageMessage(laneName, text, dataUrl) {
    const l = resolve(laneName);
    if (l.kind === 'responses') {
      return { role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] };
    }
    if (l.kind === 'anthropic') {
      return { role: 'user', content: [{ type: 'image', source: { type: 'base64', ...dataUrlParts(dataUrl) } }, { type: 'text', text }] };
    }
    if (l.kind === 'gemini') {
      const { media_type: mimeType, data } = dataUrlParts(dataUrl);
      return { role: 'user', parts: [{ inlineData: { mimeType, data } }, { text }] };
    }
    return { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }] };
  }

  // A user message carrying a WAV recording, or null when the lane's wire
  // format cannot take audio (the caller transcribes on another lane first).
  function audioMessage(laneName, text, wavBase64) {
    if (resolve(laneName).kind !== 'gemini') return null;
    return { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wavBase64 } }, { text }] };
  }

  // A short web-grounded answer: { answer, sources }.
  async function search(laneName, instructions, query, { timeoutMs = 30000 } = {}) {
    const l = resolve(laneName);
    if (l.kind === 'gemini') {
      const raw = await gemini(l, { instructions, messages: [{ role: 'user', content: query }], maxTokens: 600, extraTools: [{ googleSearch: {} }] }, timeoutMs);
      const meta = (raw.candidates && raw.candidates[0] && raw.candidates[0].groundingMetadata) || {};
      return { answer: geminiResult(raw).text, sources: [...new Set((meta.groundingChunks || []).map((c) => c.web && c.web.uri).filter(Boolean))] };
    }
    const resp = await responses(laneName, { tools: [{ type: 'web_search' }], instructions, input: query }, { timeoutMs });
    return { answer: responsesText(resp), sources: citations(resp) };
  }

  function describe(laneName) {
    const lane = config.lanes[laneName] || {};
    return `${lane.provider}/${lane.model}`;
  }

  return { turn, ask, agent, responses, search, describe, imageMessage, audioMessage };
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function responsesText(resp) {
  const parts = [];
  for (const item of (resp && resp.output) || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

function citations(resp) {
  const urls = new Set();
  for (const item of (resp && resp.output) || []) {
    for (const c of item.content || []) for (const a of c.annotations || []) if (a.type === 'url_citation' && a.url) urls.add(a.url);
  }
  return [...urls];
}

module.exports = { createLanes, responsesText, citations };
