const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLanes } = require('../src/lanes');
const { createFilesAgent, grepDir } = require('../src/tools/files-agent');

const config = {
  providers: {
    oa: { kind: 'responses', url: 'https://api.openai.com/v1/responses', keyEnv: 'K' },
    meta: { kind: 'chat', url: 'https://example.test/v1/chat/completions', keyEnv: 'K' },
  },
  lanes: { r: { provider: 'oa', model: 'gpt-6-luna' }, c: { provider: 'meta', model: 'muse-spark' } },
};

function fakeFetch(replies, seen) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const data = replies.shift();
    return { ok: true, json: async () => data };
  };
}

test('chat lane runs a tool loop in OpenAI-compatible format', async () => {
  const seen = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'find_files', arguments: '{"query":"resume"}' } }] } }] },
    { choices: [{ message: { content: 'It is in Documents.' } }] },
  ];
  const lanes = createLanes(config, { fetchImpl: fakeFetch(replies, seen), env: { K: 'secret' } });
  const ran = [];
  const out = await lanes.agent('c', {
    instructions: 'find files', task: 'where is my resume',
    tools: [{ name: 'find_files', description: 'd', parameters: { type: 'object', properties: {} }, run: (a) => { ran.push(a); return ['C:/Users/j/Documents/resume.pdf']; } }],
  });
  assert.equal(out, 'It is in Documents.');
  assert.deepEqual(ran, [{ query: 'resume' }]);
  assert.equal(seen[0].body.model, 'muse-spark');
  assert.equal(seen[0].body.messages[0].role, 'system');
  assert.equal(seen[0].body.tools[0].function.name, 'find_files');
  assert.equal(seen[1].body.messages.at(-1).role, 'tool');
  assert.equal(seen[1].body.messages.at(-1).tool_call_id, 't1');
  assert.equal(seen[0].auth, 'Bearer secret');
});

test('responses lane chains with previous_response_id', async () => {
  const seen = [];
  const replies = [
    { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'peek', arguments: '{}' }] },
    { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] },
  ];
  const lanes = createLanes(config, { fetchImpl: fakeFetch(replies, seen), env: { K: 'x' } });
  const out = await lanes.agent('r', { task: 't', tools: [{ name: 'peek', description: 'd', parameters: { type: 'object', properties: {} }, run: () => 'hi' }] });
  assert.equal(out, 'done');
  assert.equal(seen[1].body.previous_response_id, 'r1');
  assert.deepEqual(seen[1].body.input, [{ type: 'function_call_output', call_id: 'c1', output: '"hi"' }]);
});

test('a missing key names the env var', async () => {
  const lanes = createLanes(config, { fetchImpl: async () => ({}), env: {} });
  await assert.rejects(lanes.ask('c', 'x', 'y'), /K is not set/);
});

test('web search and computer use refuse a chat lane', async () => {
  const lanes = createLanes(config, { fetchImpl: async () => ({}), env: { K: 'x' } });
  await assert.rejects(lanes.responses('c', {}), /needs a responses provider/);
});

test('grep finds a phrase in text files and skips node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-grep-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.md'), 'herdr fork');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'line one\nthe herdr fork lives here\n');
  const hits = grepDir(dir, 'herdr fork');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('files agent runs on the files lane', async () => {
  const calls = [];
  const agent = createFilesAgent({ lanes: { agent: async (lane, opts) => { calls.push([lane, opts.task, opts.tools.map((t) => t.name)]); return 'found'; } }, desktop: {} });
  assert.equal(await agent.ask('where is my resume'), 'found');
  assert.deepEqual(calls[0], ['files', 'where is my resume', ['find_files', 'list_dir', 'grep', 'peek']]);
});

const gconfig = {
  providers: {
    g: { kind: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', keyEnv: 'K' },
    meta: { kind: 'chat', url: 'https://example.test/v1/chat/completions', keyEnv: 'K' },
  },
  lanes: { g: { provider: 'g', model: 'gemini-x', thinking: 'low' }, c: { provider: 'meta', model: 'm' } },
};

function geminiFetch(replies, seen) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => replies.shift() };
  };
}

test('gemini lane runs a tool loop and echoes the model turn verbatim', async () => {
  const seen = [];
  const modelTurn = { role: 'model', parts: [{ thoughtSignature: 'sig', functionCall: { id: 'f1', name: 'open', args: { target: 'steam' } } }] };
  const replies = [
    { candidates: [{ content: modelTurn }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'Opening Steam.' }] } }] },
  ];
  const lanes = createLanes(gconfig, { fetchImpl: geminiFetch(replies, seen), env: { K: 'secret' } });
  const ran = [];
  const out = await lanes.agent('g', {
    instructions: 'be quick', task: 'open steam',
    tools: [{ name: 'open', description: 'd', parameters: { type: 'object', properties: { target: { type: 'string' } } }, run: (a) => { ran.push(a); return { ok: true }; } }],
  });
  assert.equal(out, 'Opening Steam.');
  assert.deepEqual(ran, [{ target: 'steam' }]);
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.equal(seen[0].headers['x-goog-api-key'], 'secret');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.deepEqual(seen[0].body.systemInstruction, { parts: [{ text: 'be quick' }] });
  assert.deepEqual(seen[0].body.contents[0], { role: 'user', parts: [{ text: 'open steam' }] });
  assert.equal(seen[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(seen[0].body.tools[0].functionDeclarations[0].name, 'open');
  assert.deepEqual(seen[1].body.contents[1], modelTurn);
  assert.deepEqual(seen[1].body.contents[2].parts[0].functionResponse, { id: 'f1', name: 'open', response: { result: '{"ok":true}' } });
});

test('gemini lane answers in words on its last step instead of running out', async () => {
  const seen = [];
  const lanes = createLanes(gconfig, { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const none = body.toolConfig && body.toolConfig.functionCallingConfig.mode === 'NONE';
    const part = none ? { text: 'Done.' } : { functionCall: { name: 'peek', args: {} } };
    return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [part] } }] }) };
  }, env: { K: 'x' } });
  const out = await lanes.agent('g', { task: 't', maxSteps: 2, tools: [{ name: 'peek', description: 'd', parameters: { type: 'object', properties: {} }, run: () => 'hi' }] });
  assert.equal(out, 'Done.');
  assert.equal(seen.length, 3);
  assert.equal(seen[0].toolConfig, undefined);
  assert.equal(seen[2].tools[0].functionDeclarations[0].name, 'peek');
  assert.match(seen[2].contents.at(-1).parts.at(-1).text, /Answer now/);
});

test('audio goes straight to a gemini lane and nowhere else', () => {
  const lanes = createLanes(gconfig, { env: { K: 'x' } });
  assert.deepEqual(lanes.audioMessage('g', 'answer this', 'UklG'), { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'UklG' } }, { text: 'answer this' }] });
  assert.equal(lanes.audioMessage('c', 'answer this', 'UklG'), null);
});

test('gemini search grounds on Google Search and returns the sources', async () => {
  const seen = [];
  const replies = [{ candidates: [{
    content: { parts: [{ text: 'The Seahawks won.' }] },
    groundingMetadata: { groundingChunks: [{ web: { uri: 'https://a.test' } }, { web: { uri: 'https://a.test' } }, { web: { uri: 'https://b.test' } }] },
  }] }];
  const lanes = createLanes(gconfig, { fetchImpl: geminiFetch(replies, seen), env: { K: 'x' } });
  const r = await lanes.search('g', 'be brief', 'who won');
  assert.deepEqual(r, { answer: 'The Seahawks won.', sources: ['https://a.test', 'https://b.test'] });
  assert.deepEqual(seen[0].body.tools, [{ googleSearch: {} }]);
});
