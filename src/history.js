// Recent operations for the dock: the last things Butler did that are worth a
// one-click repeat. Persisted as JSON lines so they survive restarts.
const fs = require('fs');
const path = require('path');

function label(entry) {
  const a = entry.args || {};
  switch (entry.tool) {
    case 'open': return `Open ${a.target}`;
    case 'routine_start': return `${a.kind || 'routine'} ${a.interval_s || ''}${a.interval_s ? 's' : ''}`.trim();
    case 'spawn_agent': return `${a.recipe || a.cli || 'agent'}${a.model ? ` (${a.model})` : ''}: ${String(a.task || 'blank').slice(0, 40)}`;
    case 'computer_task': return `Do: ${String(a.goal || '').slice(0, 48)}`;
    case 'web_search': return `Search: ${String(a.query || '').slice(0, 44)}`;
    case 'open_herdr': return 'Open herdr';
    case 'media': return `Media ${a.action}`;
    default: return entry.tool;
  }
}

function createHistory({ dir, max = 40, onChange = () => {} }) {
  const file = path.join(dir, 'history.jsonl');
  let items = [];
  try {
    items = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-max);
  } catch { /* first run */ }

  function add(entry) {
    const e = { ...entry, at: Date.now() };
    e.label = label(e);
    items = items.filter((i) => i.label !== e.label).concat(e).slice(-max);
    try { fs.writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n'); } catch { /* read-only disk */ }
    onChange(recent());
  }

  function recent(n = 10) { return items.slice(-n).reverse(); }

  return { add, recent };
}

module.exports = { createHistory, label };
