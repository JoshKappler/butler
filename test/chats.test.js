const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChats } = require('../src/chats');

test('chats split on the gap, list newest first, and survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'butler-chats-'));
  let t = 1000;
  const chats = createChats({ dir, ttlMs: 300000, now: () => t });
  chats.record('open steam', 'Opening Steam.');
  t += 299999;
  chats.record('and discord', 'Done.');
  t += 300000;
  assert.equal(chats.current(), null);
  chats.record('weather', 'Sunny.');
  const list = chats.list();
  assert.deepEqual(list.map((c) => [c.title, c.count, c.current]), [['weather', 1, true], ['open steam', 2, false]]);
  const again = createChats({ dir, ttlMs: 300000, now: () => t });
  assert.equal(again.get(list[1].id).turns[1].heard, 'and discord');
});

test('a new chat Josh asks for starts on the next exchange', () => {
  let t = 1000;
  const chats = createChats({ ttlMs: 300000, now: () => t });
  chats.record('open steam', 'Opening Steam.', '- Steam is at C:/Steam');
  t += 1000;
  chats.startNew();
  assert.equal(chats.current(), null);
  chats.record('weather', 'Sunny.');
  assert.deepEqual(chats.list().map((c) => [c.title, c.current]), [['weather', true], ['open steam', false]]);
  assert.equal(chats.list()[1].count, 1);
  assert.equal(chats.get(chats.list()[1].id).turns[0].shown, '- Steam is at C:/Steam');
});
