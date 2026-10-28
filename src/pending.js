// Questions background work is waiting on: a PowerShell command to approve, a
// computer task asking "buy this?". Josh answers by voice (the model calls
// answer_pending) or by clicking in the dock; whichever lands first wins.
function createPending({ onChange = () => {}, timeoutMs = 5 * 60 * 1000 } = {}) {
  const open = new Map();
  let nextId = 1;

  function list() {
    return [...open.values()].map(({ id, kind, question, from, created }) => ({ id, kind, question, from, created }));
  }

  function ask(kind, question, from = '') {
    const id = `q${nextId++}`;
    return {
      id,
      answer: new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, null), timeoutMs);
        open.set(id, { id, kind, question, from, created: Date.now(), resolve, timer });
        onChange(list());
      }),
    };
  }

  function settle(id, answer) {
    const q = open.get(id);
    if (!q) return false;
    clearTimeout(q.timer);
    open.delete(id);
    q.resolve(answer);
    onChange(list());
    return true;
  }

  return { ask, answer: settle, list };
}

const YES = /^\s*(y|yes|yeah|yep|ok|okay|sure|go|go ahead|continue|do it|allow|approve[d]?|confirm(ed)?)\b/i;

module.exports = { createPending, YES };
