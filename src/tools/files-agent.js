// A small, cheap subagent for "find me..." questions about files on this PC.
// The voice model hands it the question; it searches, peeks and answers in a
// sentence plus paths. Runs on the "files" lane, so it can be Muse Spark,
// Gemini Flash, Haiku or a small GPT, whichever is fastest this month.
const fs = require('fs');
const path = require('path');
const { expand } = require('./desktop');

const INSTRUCTIONS = `You find files on Josh's Windows PC and answer questions about them.
Search by name first (find_files), then narrow with list_dir, grep and peek. Stop as soon as you can answer.
Answer in one or two plain sentences, then the absolute paths that matter, one per line. If you could not find it, say where you looked.`;

const SKIP = /^(node_modules|\.git|\.venv|venv|__pycache__|AppData|target|dist|build)$/;

function grepDir(root, pattern, { limit = 20, budgetMs = 3000, maxBytes = 2e6 } = {}) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const deadline = Date.now() + budgetMs;
  const hits = [];
  const queue = [[root, 0]];
  while (queue.length && hits.length < limit && Date.now() < deadline) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6 && !SKIP.test(e.name) && !e.name.startsWith('.')) queue.push([full, depth + 1]); continue; }
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > maxBytes || !/\.(txt|md|json|js|ts|py|ps1|ahk|toml|ya?ml|csv|html|css|rs|go|cs|ini|cfg|log|sql)$/i.test(e.name)) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) hits.push({ path: full, line: i + 1, text: lines[i].trim().slice(0, 160) });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

function fileTools(desktop) {
  return [
    {
      name: 'find_files',
      description: 'Find files and folders whose names contain all the words.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: (a) => desktop.findFiles(a.query, 25),
    },
    {
      name: 'list_dir',
      description: 'List a folder, newest first, with sizes.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: (a) => {
        const dir = expand(a.path);
        return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 400).map((e) => {
          let st = null;
          try { st = fs.statSync(path.join(dir, e.name)); } catch { /* vanished */ }
          return { name: e.name + (e.isDirectory() ? '/' : ''), size: st ? st.size : null, modified: st ? st.mtime.toISOString().slice(0, 16) : null };
        }).sort((x, y) => String(y.modified).localeCompare(String(x.modified))).slice(0, 80);
      },
    },
    {
      name: 'grep',
      description: 'Search text files under a folder for a regex or phrase. Returns the first matching line per file.',
      parameters: { type: 'object', properties: { folder: { type: 'string' }, pattern: { type: 'string' } }, required: ['folder', 'pattern'] },
      run: (a) => grepDir(expand(a.folder), a.pattern),
    },
    {
      name: 'peek',
      description: 'Read the start of a text file.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, chars: { type: 'number' } }, required: ['path'] },
      run: (a) => fs.readFileSync(expand(a.path), 'utf8').slice(0, Math.min(Number(a.chars) || 3000, 12000)),
    },
  ];
}

function createFilesAgent({ lanes, desktop }) {
  const tools = fileTools(desktop);
  return {
    ask: (question) => lanes.agent('files', { instructions: INSTRUCTIONS, task: question, tools, maxSteps: 8 }),
  };
}

module.exports = { createFilesAgent, grepDir, fileTools };
