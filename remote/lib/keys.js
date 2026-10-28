// Every Redis key the relay uses.
module.exports = {
  STATE: 'butler:state',        // JSON snapshot from the PC
  EVENTS: 'butler:events',      // newest first, capped
  CMDS: 'butler:cmds',          // phone -> PC queue
  SCREEN: 'butler:screen',      // latest screenshot, base64 JPEG
  SEEN: 'butler:pc-seen',       // last time the PC polled, ms
  seq: 'butler:seq',            // event and command ids
  login: (ip) => `butler:login:${ip}`,
  MAX_EVENTS: 200,
};
