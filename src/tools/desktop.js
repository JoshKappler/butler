// Desktop helpers behind Butler's quick tools: resolve "open X" to an app, URL
// or path; find files fast; run PowerShell with a gate.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function expand(p) {
  if (!p) return p;
  let s = String(p).trim().replace(/^"|"$/g, '');
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  return s.replace(/%([^%]+)%/g, (m, k) => process.env[k] || m);
}

// Scores a Start menu entry against what Josh said. Exact beats prefix beats
// word match beats in-order letters, and shorter names win ties.
function scoreApp(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85 - Math.min(10, n.length - q.length) / 2;
  const words = n.split(/[^a-z0-9]+/);
  if (words.includes(q)) return 75;
  if (q.split(/\s+/).every((w) => n.includes(w))) return 65 - Math.min(10, n.length / 10);
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 40 - Math.min(20, n.length / 4) : 0;
}

function matchApps(apps, query, aliases = {}) {
  const q = (aliases[query.toLowerCase()] || query).toString();
  return apps
    .map((a) => ({ ...a, score: scoreApp(a.name, q) }))
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score);
}

function createDesktop({ winhost, config, log = () => {} }) {
  let apps = null;
  let appsAt = 0;

  async function startApps() {
    if (!apps || Date.now() - appsAt > 10 * 60 * 1000) {
      apps = await winhost.call('apps', {}, { timeout: 20000 });
      appsAt = Date.now();
    }
    return apps;
  }

  // One "open" for everything: URL, file or folder, known command, Start menu app.
  async function open(target) {
    const t = String(target || '').trim();
    if (!t) throw new Error('nothing to open');
    const custom = (config.shortcuts || {})[t.toLowerCase()];
    if (custom) {
      await winhost.call('open', { target: custom.target, args: custom.args });
      return { opened: t, via: 'shortcut' };
    }
    if (/^(https?:\/\/|www\.)/i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) {
      const url = /^https?:/i.test(t) ? t : `https://${t}`;
      await winhost.call('open', { target: url });
      return { opened: url, via: 'browser' };
    }
    const p = expand(t);
    if (/[\\/:]/.test(p) && fs.existsSync(p)) {
      await winhost.call('open', { target: p });
      return { opened: p, via: 'path' };
    }
    const hits = matchApps(await startApps(), t, config.appAliases || {});
    if (!hits.length) throw new Error(`no app, file or site matches "${t}"`);
    const best = hits[0];
    await winhost.call('open', { target: 'explorer.exe', args: [`shell:AppsFolder\\${best.id}`] });
    return { opened: best.name, via: 'app', alternatives: hits.slice(1, 4).map((h) => h.name) };
  }

  // Everything (voidtools es.exe) answers in milliseconds when installed; the
  // fallback walks the configured roots with a time budget.
  async function findFiles(query, limit = 15) {
    const es = config.search.everything;
    if (es) {
      try {
        const out = await new Promise((resolve, reject) => {
          execFile(es, ['-n', String(limit), ...String(query).split(/\s+/)], { timeout: 4000, windowsHide: true },
            (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
        });
        return { engine: 'everything', results: out.split(/\r?\n/).filter(Boolean).slice(0, limit) };
      } catch (err) {
        log(`everything failed: ${err.message}`);
      }
    }
    return { engine: 'walk', results: walkSearch(config.search.roots.map(expand), query, limit, config.search.budgetMs || 3000) };
  }

  return { open, findFiles, startApps };
}

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'AppData', '$Recycle.Bin', 'target', 'dist', 'build', '.cache']);

function walkSearch(roots, query, limit, budgetMs) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const deadline = Date.now() + budgetMs;
  const results = [];
  const queue = roots.filter((r) => r && fs.existsSync(r)).map((r) => [r, 0]);
  while (queue.length && results.length < limit && Date.now() < deadline) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        results.push(full);
        if (results.length >= limit) break;
      }
      if (e.isDirectory() && depth < 7 && !SKIP.has(e.name) && !e.name.startsWith('.')) queue.push([full, depth + 1]);
    }
  }
  return results;
}

// Read-only commands run straight away; anything else waits for Josh.
const SAFE = /^(get-|test-|resolve-|measure-|select-string|select-object|sort-object|where-object|format-|out-string|convertto-json|dir\b|ls\b|gci\b|cat\b|type\b|whoami|hostname|ipconfig|systeminfo|tasklist|where(\.exe)?\b|echo\b|write-output)/i;
const NEVER = /(format-volume|clear-disk|remove-partition|initialize-disk|bcdedit|vssadmin\s+delete|cipher\s+\/w|diskpart|reg\s+delete\s+hk(lm|ey_local_machine)|remove-item\s+.*-recurse.*\s[a-z]:\\?\s*$)/i;

function needsApproval(command) {
  const c = String(command);
  if (/[>]|`|\$\(|invoke-expression|iex\b|start-process|-encodedcommand/i.test(c)) return true;
  return !c.split(/[|;]|&&|\|\|/).map((s) => s.trim()).filter(Boolean).every((seg) => SAFE.test(seg));
}

function runPowerShell(command, { exe = 'powershell.exe', timeoutMs = 60000 } = {}) {
  if (NEVER.test(command)) return Promise.resolve({ refused: true, reason: 'command is on the never-run list' });
  return new Promise((resolve) => {
    const child = spawn(exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'], {
      cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (d) => { if (out.length < 16000) out += String(d); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ exit: -1, output: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code, output: out.slice(0, 8000) }); });
    child.stdin.end(command + '\n');
  });
}

module.exports = { createDesktop, scoreApp, matchApps, needsApproval, runPowerShell, walkSearch, expand, NEVER };
