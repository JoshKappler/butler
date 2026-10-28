// Loads config.default.json, then deep-merges the user's overrides from
// %APPDATA%\Butler\config.json and ./config.local.json. Also loads .env files
// so keys never live in config; a key saved in %APPDATA%\Butler\.env (the
// settings page writes there) beats one inherited from the environment.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function userDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'Butler');
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// paths may reference each other: "mole": "{projects}/MOLE".
function resolvePaths(paths) {
  const out = { ...paths };
  for (let pass = 0; pass < 5; pass++) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'string') continue;
      out[k] = v.replace(/\{(\w+)\}/g, (m, name) => (name !== k && typeof out[name] === 'string' ? out[name] : m));
    }
  }
  for (const k of Object.keys(out)) if (!/\{/.test(out[k])) out[k] = expandHome(out[k]);
  return out;
}

function loadEnv(file, { override = false } = {}) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && (override || !process.env[m[1]])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig({ root = ROOT, dir = userDir() } = {}) {
  loadEnv(path.join(root, '.env'));
  loadEnv(path.join(dir, '.env'), { override: true });
  let cfg = readJson(path.join(root, 'config.default.json'));
  cfg = merge(cfg, readJson(path.join(dir, 'config.json')));
  cfg = merge(cfg, readJson(path.join(root, 'config.local.json')));
  cfg.paths = resolvePaths(cfg.paths);
  cfg.herdr.bin = expandHome(cfg.herdr.bin);
  cfg.herdr.launch = (cfg.herdr.launch || []).map(expandHome);
  cfg.stateDir = path.join(dir, 'state');
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  return cfg;
}

module.exports = { loadConfig, merge, resolvePaths, userDir, ROOT };
