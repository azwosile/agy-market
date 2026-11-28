// Safe zero-dependency Markdown-to-HTML renderer for plugin README & changelog previews (`src/ui/markdown.mjs`).
// Escapes all raw HTML first so untrusted READMEs and release notes cannot inject scripts or event handlers.
// Converts internal `sidecar://` URIs into Sidebar opener buttons so zero raw
// Chromium-blocked protocol `<a href>` links ever appear inside the isolated Sidebar iframe.

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEmphasis(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
}

function formatInline(escapedLine) {
  const fragments = [];
  const stash = html => {
    fragments.push(html);
    return '\u0000' + (fragments.length - 1) + '\u0000';
  };
  // Keep generated markup out of subsequent formatting passes. Linked badges
  // use their alt text as the link label without fetching a third-party image.
  const inline = /`([^`]+)`|\[!\[([^\]]*)\]\([^\s)]*\)\]\((https?:\/\/[^\s)]+)\)|!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+|sidecar:\/\/[^\s)]+|customization:\/\/[^\s)]+)\)/g;
  const text = escapedLine.replace(/\u0000/g, '').replace(inline,
    (_match, code, badge, destination, alt, label, url) => {
      if (code !== undefined) return stash(`<code class="md-code">${code}</code>`);
      if (alt !== undefined) return stash(alt ? `<span class="md-img-alt">[${alt}]</span>` : '');
      const href = destination || url;
      const body = badge !== undefined ? (badge || href) : label.split(/(`[^`]+`)/g).map((part, i) =>
        i % 2 ? '<code class="md-code">' + part.slice(1, -1) + '</code>' : formatEmphasis(part)).join('');
      if (href.startsWith('sidecar://')) {
        return stash(`<button type="button" class="md-pill-btn" data-action="open-uri-pane" data-uri="${href}" data-label="${label}" title="打开 Sidebar 侧边栏 / Open Sidebar">${body}</button>`);
      }
      if (href.startsWith('customization://')) return stash(`<span class="md-code" title="${href}">${body}</span>`);
      return stash(`<a href="${href}" target="_blank" rel="noopener noreferrer" class="md-link">${body}</a>`);
    });
  return formatEmphasis(text)
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => fragments[index]);
}

function isTableSeparator(line) {
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(line);
}

function splitTableRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function renderSafeMarkdown(rawMd, emptyText = '暂无 README 文档 / No README provided.') {
  const src = String(rawMd || '').trim();
  if (!src) return `<p class="md-empty muted">${escapeHtml(emptyText)}</p>`;

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let listType = ''; // '' | 'ul' | 'ol'

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim().slice(0, 24);
        codeBuf = [];
      } else {
        const langBadge = codeLang ? `<div class="md-code-lang">${escapeHtml(codeLang)}</div>` : '';
        out.push(`<div class="md-pre-wrap">${langBadge}<pre class="md-pre"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre></div>`);
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLine);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // Headings
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      closeList();
      const lvl = Math.min(6, hMatch[1].length + 1);
      out.push(`<h${lvl} class="md-h md-h${hMatch[1].length}">${formatInline(escapeHtml(hMatch[2]))}</h${lvl}>`);
      continue;
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      closeList();
      const headers = splitTableRow(trimmed);
      i += 1; // skip separator
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].trim().includes('|') && lines[i + 1].trim() !== '') {
        i += 1;
        rows.push(splitTableRow(lines[i].trim()));
      }
      const headHtml = `<thead><tr>${headers.map((c) => `<th>${formatInline(escapeHtml(c))}</th>`).join('')}</tr></thead>`;
      const bodyHtml = rows.length
        ? `<tbody>${rows
            .map((r) => `<tr>${headers.map((_h, idx) => `<td>${formatInline(escapeHtml(r[idx] || ''))}</td>`).join('')}</tr>`)
            .join('')}</tbody>`
        : '';
      out.push(`<div class="md-table-wrap"><table class="md-table">${headHtml}${bodyHtml}</table></div>`);
      continue;
    }

    // Unordered list (including task checkboxes)
    const ulMatch = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (ulMatch) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="md-ul">');
        listType = 'ul';
      }
      const itemBody = ulMatch[1];
      const taskMatch = /^\[(x|X| )\]\s+(.*)$/.exec(itemBody);
      if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === 'x';
        out.push(
          `<li class="md-task"><span class="md-check ${checked ? 'is-checked' : ''}">${checked ? '✓' : ''}</span><span>${formatInline(escapeHtml(taskMatch[2]))}</span></li>`,
        );
      } else {
        out.push(`<li>${formatInline(escapeHtml(itemBody))}</li>`);
      }
      continue;
    }

    // Ordered list
    const olMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (olMatch) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol class="md-ol">');
        listType = 'ol';
      }
      out.push(`<li>${formatInline(escapeHtml(olMatch[1]))}</li>`);
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
    out.push(`<div class="md-pre-wrap"><pre class="md-pre"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre></div>`);
  }
  return out.join('\n');
}
