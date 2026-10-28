// Loopback HTTP endpoint for everything outside Butler that needs to reach it:
// the AutoHotkey key script (Pause and Home) and Claude/Codex hooks. Every
// call except /health carries the token from %APPDATA%\Butler\state\token.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

function loadToken(stateDir) {
  const file = path.join(stateDir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createControl({ port, stateDir, routes, log = () => {} }) {
  const token = loadToken(stateDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return send(200, { ok: true });
    // Browsers cannot forge this header cross-origin without a preflight we never answer.
    if (!safeEqual(req.headers['x-butler-token'], token)) return send(401, { error: 'bad token' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      const handler = routes[url.pathname];
      if (!handler) return send(404, { error: 'no route' });
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad json' }); }
      try {
        send(200, (await handler(data)) || { ok: true });
      } catch (err) {
        log(`control ${url.pathname}: ${err.message}`);
        send(500, { error: err.message });
      }
    });
  });

  server.listen(port, '127.0.0.1', () => log(`control listening on 127.0.0.1:${port}`));
  server.on('error', (err) => log(`control server: ${err.message}`));
  return { token, close: () => server.close() };
}

module.exports = { createControl, loadToken };
