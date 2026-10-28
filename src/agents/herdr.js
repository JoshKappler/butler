// Thin wrapper over the herdr CLI (Josh's fork at ~/.local/bin/herdr.exe).
// Every command prints JSON; errors exit non-zero with the message on stderr.
// Agent targets are either a Butler-given name or a pane id like w1:p2.
const { execFile } = require('child_process');

function createHerdr({ bin = 'herdr', session = '', exec = execFile, timeoutMs = 20000 } = {}) {
  // A Butler launched from inside a herdr pane would otherwise inherit that
  // pane's socket and talk to the wrong server.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^HERDR_/.test(k)) delete env[k];
  if (session) env.HERDR_SESSION = session;

  function run(args, { timeout = timeoutMs, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      exec(bin, args, { env, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim().slice(0, 500)));
        const text = String(stdout || '').trim();
        if (raw) return resolve(String(stdout || ''));
        if (!text) return resolve(null);
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
  }

  const result = (r) => (r && r.result !== undefined ? r.result : r);

  return {
    run,
    async alive() {
      try { await run(['workspace', 'list'], { timeout: 4000 }); return true; } catch { return false; }
    },
    async workspaces() { return result(await run(['workspace', 'list'])).workspaces || []; },
    async createWorkspace({ cwd, label, focus = false }) {
      const args = ['workspace', 'create', focus ? '--focus' : '--no-focus'];
      if (cwd) args.push('--cwd', cwd);
      if (label) args.push('--label', label);
      return result(await run(args));
    },
    async createTab({ workspace, cwd, label, focus = false }) {
      const args = ['tab', 'create', focus ? '--focus' : '--no-focus'];
      if (workspace) args.push('--workspace', workspace);
      if (cwd) args.push('--cwd', cwd);
      if (label) args.push('--label', label);
      return result(await run(args));
    },
    async agents() { return result(await run(['agent', 'list'])).agents || []; },
    async startAgent({ name, kind, pane, args = [] }) {
      const a = ['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '45000'];
      if (args.length) a.push('--', ...args);
      return result(await run(a, { timeout: 60000 }));
    },
    // Pastes the text and presses Enter as one step, so a busy TUI cannot split it.
    async prompt(target, text) { return result(await run(['agent', 'prompt', target, text])); },
    async sendKeys(target, keys) { return result(await run(['agent', 'send-keys', target, ...keys])); },
    // Claude and Codex draw on the alternate screen, so the visible grid is the truth.
    // Prints the screen text itself, not JSON.
    async read(target, lines = 80, source = 'visible') {
      return run(['agent', 'read', target, '--source', source, '--lines', String(lines)], { raw: true });
    },
    async focus(target) { return result(await run(['agent', 'focus', target])); },
    async closePane(pane) { return result(await run(['pane', 'close', pane])); },
    async closeWorkspace(id) { return result(await run(['workspace', 'close', id])); },
    async notify(title, body) {
      return result(await run(['notification', 'show', title, '--body', body, '--sound', 'none']));
    },
  };
}

module.exports = { createHerdr };
