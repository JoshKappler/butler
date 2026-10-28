# Butler remote

A private site on Vercel that your phone and Butler both talk to. The phone
queues commands and reads state; Butler on the PC polls once a second, runs the
commands, and posts state, events and screenshots back. The PC only makes
outbound HTTPS calls, so nothing on it is exposed to the internet.

```
phone ── cookie ──▶ Vercel (this folder) ◀── bearer token ── Butler on the PC
                       │
                 Upstash Redis: state, events, command queue, last screenshot
```

## Deploy

1. Vercel, New Project, import this repo. **Root Directory: `remote`**, framework
   preset **Other**, no build command.
2. Storage tab: add **Upstash Redis** (Marketplace) to the project. It sets
   `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Environment variables (Production):

   | Name | Value |
   |---|---|
   | `BUTLER_PASSCODE` | What you type on the phone. Long; it is the front door. |
   | `BUTLER_SESSION_SECRET` | `openssl rand -base64 48` |
   | `BUTLER_PC_TOKEN` | `openssl rand -base64 48` |
   | `OPENAI_API_KEY` | For the phone's mic (speech to text). Optional: without it, use the keyboard's dictation key. |
   | `BUTLER_STT_MODEL` | Optional, default `gpt-4o-transcribe`. |

4. Deploy, then on the PC:
   - `%APPDATA%\Butler\.env`: `BUTLER_PC_TOKEN=<same value>`
   - `%APPDATA%\Butler\config.json`: `{ "relay": { "url": "https://<your-app>.vercel.app" } }`
   - Restart Butler from the tray. The phone shows "<your PC name> online" within a second.
5. On the phone: open the URL in Safari, sign in, Share, Add to Home Screen.

## Locks

- Phone: passcode, then a 30-day session cookie, HMAC-signed, HttpOnly, Secure,
  SameSite=Strict. Ten wrong passcodes from one address lock it for 15 minutes.
  Every state-changing call also needs JSON plus an `X-Butler` header, which a
  cross-site form cannot send.
- PC: its own bearer token, separate from the phone's.
- Anything that spends money, sends messages or deletes still waits for an
  explicit Allow, the same as at the desk.
- Rotating any of the three secrets in Vercel and redeploying signs everything out.

## What the phone can do

Talk to Butler (hold the mic button, or tap once to start and again to stop; the
audio is transcribed here and sent like typed text) or type to it. Answer approvals,
run the dock's tiles, watch agents and read their screens, send them keys or a
message, stop routines, and look at the PC's screen. Turn on **Control** to drive it
by hand: tap to click, double tap to double click, press and hold to right click, a
key row, scrolling, and a field that types on the PC. Each input brings back a fresh
screenshot.
