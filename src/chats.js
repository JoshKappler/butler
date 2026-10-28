// Butler's conversations. A chat runs until Josh starts a new one or goes
// voice.chatGapMinutes without a word; the current one is what the voice lane
// remembers. Persisted as JSON so the dock's history column survives restarts.
const fs = require('fs');
const path = require('path');

function createChats({ dir, ttlMs, keep = 200, now = Date.now }) {
  const file = dir ? path.join(dir, 'chats.json') : null;
  let chats = [];
  let fresh = false; // Josh asked for a new chat; the next exchange starts one
  try { chats = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

  const save = () => {
    if (!file) return;
    try { fs.writeFileSync(file, JSON.stringify(chats.slice(-keep))); } catch { /* read-only disk */ }
  };

  // The newest chat, if its last exchange is fresher than ttlMs.
  function current() {
    const last = chats[chats.length - 1];
    return !fresh && last && now() - last.updated < ttlMs ? last : null;
  }

  // shown: what the answer put in the dock, so a follow-up can refer to it.
  function record(heard, answer, shown) {
    const at = now();
    let chat = current();
    if (!chat) { chat = { id: `c${at}`, started: at, updated: at, turns: [] }; chats.push(chat); }
    fresh = false;
    chat.turns.push(shown ? { at, heard, answer, shown } : { at, heard, answer });
    chat.updated = at;
    save();
    return chat;
  }

  function list() {
    const live = current();
    return chats.slice().reverse().map((c) => ({
      id: c.id, updated: c.updated, count: c.turns.length, current: c === live,
      title: (c.turns.find((t) => t.heard) || c.turns[0] || {}).heard || 'Untitled',
    }));
  }

  const get = (id) => chats.find((c) => c.id === id) || null;

  return { current, startNew: () => { fresh = true; }, record, list, get };
}

module.exports = { createChats };
