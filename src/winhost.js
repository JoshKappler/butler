// Client for win/winhost.ps1, the long-lived PowerShell process that owns the
// mouse, keyboard, screen and window list. One JSON request per line out, one
// JSON reply per line back, matched by id. Restarts itself if the host dies.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const SCRIPT = path.join(__dirname, '..', 'win', 'winhost.ps1');

function createWinhost({ exe = 'powershell.exe', timeoutMs = 15000, log = () => {} } = {}) {
  let child = null;
  let nextId = 1;
  const pending = new Map();
  let stopped = false;

  function start() {
    if (process.platform !== 'win32') return;
    child = spawn(exe, ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return log(`winhost: bad line ${line.slice(0, 200)}`); }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'winhost error'));
    });
    child.stderr.on('data', (d) => log(`winhost stderr: ${String(d).slice(0, 500)}`));
    child.on('exit', (code) => {
      log(`winhost exited ${code}`);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('winhost exited')); }
      pending.clear();
      child = null;
      if (!stopped) setTimeout(start, 1000);
    });
  }

  function call(op, args = {}, { timeout = timeoutMs } = {}) {
    if (process.platform !== 'win32') return Promise.reject(new Error('winhost runs on Windows only'));
    if (!child) start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`winhost ${op} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  function stop() {
    stopped = true;
    if (child) child.kill();
  }

  start();
  return { call, stop };
}

module.exports = { createWinhost };
