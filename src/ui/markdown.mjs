// Safe zero-dependency Markdown-to-HTML renderer for plugin README previews (`src/ui/markdown.mjs`).
// Escapes all raw HTML first so untrusted READMEs cannot inject scripts or event handlers.

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(escapedLine) {
  return escapedLine
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|sidecar:\/\/[^\s)]+|customization:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`;
    });
}

export function renderSafeMarkdown(rawMd) {
  const src = String(rawMd || '').trim();
  if (!src) return '<p class="muted">暂无 README 文档 / No README provided.</p>';

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    if (rawLine.trim().startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        out.push(`<pre class="md-pre"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const hMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      closeList();
      const lvl = hMatch[1].length + 1;
      out.push(`<h${lvl} class="md-h">${formatInline(escapeHtml(hMatch[2]))}</h${lvl}>`);
      continue;
    }

    const liMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (liMatch) {
      if (!inList) {
        out.push('<ul class="md-ul">');
        inList = true;
      }
      out.push(`<li>${formatInline(escapeHtml(liMatch[1]))}</li>`);
      continue;
    }

    closeList();
    if (trimmed.startsWith('>')) {
      out.push(`<blockquote class="md-quote">${formatInline(escapeHtml(trimmed.replace(/^>\s?/, '')))}</blockquote>`);
    } else {
      out.push(`<p class="md-p">${formatInline(escapeHtml(trimmed))}</p>`);
    }
  }

  closeList();
  if (inCode && codeBuf.length) {
    out.push(`<pre class="md-pre"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}
