// Just enough markdown for the dock's cards: headings, bullets, code, bold,
// inline code and links. Everything is escaped first, so model output can
// never inject markup.
const MD = (() => {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  }

  function render(src) {
    const lines = esc(String(src || '')).split(/\r?\n/);
    const out = [];
    let list = false;
    let code = null;
    for (const line of lines) {
      if (line.startsWith('```')) {
        if (code === null) code = [];
        else { out.push(`<pre>${code.join('\n')}</pre>`); code = null; }
        continue;
      }
      if (code !== null) { code.push(line); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
      if (bullet) {
        if (!list) { out.push('<ul>'); list = true; }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (list) { out.push('</ul>'); list = false; }
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (h) out.push(`<h3>${inline(h[1])}</h3>`);
      else if (line.trim()) out.push(`<div>${inline(line)}</div>`);
    }
    if (list) out.push('</ul>');
    if (code !== null) out.push(`<pre>${code.join('\n')}</pre>`);
    return out.join('');
  }

  return { render, esc };
})();
if (typeof module !== 'undefined') module.exports = MD;
