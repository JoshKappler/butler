// Times candidate models for Butler's side lanes on this machine and network,
// so the pick in config.lanes rests on numbers, not launch posts.
//   node scripts/bench-lanes.js            every candidate whose key is set
// Two tests: a one-line answer (time to answer), and a small file-search task
// with tools against a temp folder (tool use, several round trips).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLanes } = require('../src/lanes');
const { createFilesAgent } = require('../src/tools/files-agent');

const CANDIDATES = [
  { provider: 'openai', model: 'gpt-6-luna' },
  { provider: 'openai', model: 'gpt-6-sol', params: { reasoning: { effort: 'low' } } },
  { provider: 'meta', model: 'muse-spark-1.3', params: { reasoning_effort: 'minimal' } },
  { provider: 'meta', model: 'muse-spark-1.3', params: { reasoning_effort: 'low' } },
  { provider: 'gemini', model: 'gemini-flash-latest' },
  { provider: 'anthropic', model: 'claude-opus-5' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-bench-'));
  fs.mkdirSync(path.join(dir, 'taxes', '2025'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects', 'herdr-josh', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'taxes', '2025', 'w2-notes.txt'), 'Employer: Acme\nBox 1 wages: 88,400\n');
  fs.writeFileSync(path.join(dir, 'projects', 'herdr-josh', 'README.md'), '# herdr fork\nsidebar and detail panel\n');
  fs.writeFileSync(path.join(dir, 'projects', 'notes.md'), 'nothing here\n');
  return dir;
}

async function time(fn) {
  const t = Date.now();
  try { const out = await fn(); return { ms: Date.now() - t, out: String(out).replace(/\s+/g, ' ').slice(0, 60) }; } catch (err) { return { ms: Date.now() - t, out: `ERR ${err.message.slice(0, 60)}` }; }
}

(async () => {
  const config = loadConfig();
  const dir = fixture();
  const desktop = { findFiles: async (q) => ({ results: require('../src/tools/desktop').walkSearch([dir], q, 20, 2000) }) };
  console.log(`fixture: ${dir}\n`);
  console.log('lane'.padEnd(46), 'ping ms'.padStart(8), 'files ms'.padStart(9), '  answer');
  for (const c of CANDIDATES) {
    const p = config.providers[c.provider];
    if (!p || !process.env[p.keyEnv]) continue;
    const cfg = { ...config, lanes: { files: c, fast: c } };
    const lanes = createLanes(cfg);
    const label = `${c.provider}/${c.model}${c.params ? ' ' + JSON.stringify(c.params) : ''}`.slice(0, 46);
    const pings = [];
    for (let i = 0; i < 3; i++) pings.push((await time(() => lanes.ask('fast', 'Reply with exactly: OK', 'ping', { maxTokens: 20 }))).ms);
    const files = await time(() => createFilesAgent({ lanes, desktop }).ask(`Under ${dir}, what were the Box 1 wages in the 2025 tax notes?`));
    const median = pings.sort((a, b) => a - b)[1];
    console.log(label.padEnd(46), String(median).padStart(8), String(files.ms).padStart(9), ' ', files.out);
  }
})();
