(function exposeNotebookReader(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StoneNotebookReader = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function splitLongText(text, limit = 320) {
    const source = String(text || "").trim();
    if (source.length <= limit) return source ? [source] : [];
    const sentences = source.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [source];
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > limit) {
        chunks.push(current.trim());
        current = "";
      }
      if (sentence.length <= limit) {
        current += sentence;
        continue;
      }
      if (current) chunks.push(current.trim());
      current = "";
      for (let offset = 0; offset < sentence.length; offset += limit) {
        chunks.push(sentence.slice(offset, offset + limit).trim());
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(Boolean);
  }

  function parseImageLine(line) {
    const match = String(line || "").trim().match(/^!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)$/);
    return match ? { alt: match[1].trim() || "笔记图片", source: match[2].trim(), title: (match[3] || "").trim() } : null;
  }

  function renderMarkdownBlocks(markdown, { resolveImageUrl = () => null } = {}) {
    const lines = String(markdown || "").split(/\r?\n/);
    const blocks = [];
    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      for (const chunk of splitLongText(paragraph.join(" "))) {
        blocks.push({ type: "paragraph", weight: chunk.length + 42, html: `<p>${inline(chunk)}</p>` });
      }
      paragraph = [];
    };
    for (const line of lines) {
      if (!line.trim()) { flush(); continue; }
      const image = parseImageLine(line);
      if (image) {
        flush();
        const source = resolveImageUrl(image.source);
        if (source) {
          const caption = image.alt === "笔记图片" ? "" : `<figcaption>${escapeHtml(image.alt)}</figcaption>`;
          blocks.push({
            type: "image",
            weight: 320,
            html: `<figure class="note-image"><img src="${escapeHtml(source)}" alt="${escapeHtml(image.alt)}"${image.title ? ` title="${escapeHtml(image.title)}"` : ""} loading="lazy" decoding="async" referrerpolicy="no-referrer">${caption}</figure>`,
          });
        } else {
          blocks.push({ type: "image-warning", weight: 90, html: `<p class="image-warning">图片链接未显示：${escapeHtml(image.alt)}</p>` });
        }
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flush();
        const level = heading[1].length + 1;
        blocks.push({ type: "heading", weight: heading[2].length + 105, html: `<h${level}>${inline(heading[2])}</h${level}>` });
      } else if (/^[-*]\s+/.test(line)) {
        flush();
        const text = line.replace(/^[-*]\s+/, "");
        blocks.push({ type: "list", weight: text.length + 54, html: `<p class="list-item">• ${inline(text)}</p>` });
      } else paragraph.push(line.trim());
    }
    flush();
    return blocks;
  }

  function paginateBlocks(blocks, budget = 420) {
    const pages = [];
    let page = [];
    let weight = 0;
    for (const block of blocks) {
      const blockWeight = Math.max(1, Number(block.weight) || 1);
      if (page.length && weight + blockWeight > budget) {
        pages.push(page);
        page = [];
        weight = 0;
      }
      page.push(block);
      weight += blockWeight;
    }
    if (page.length || !pages.length) pages.push(page);
    return pages;
  }

  function resolveImageUrl(source, { base, topicId } = {}) {
    const value = String(source || "").trim();
    if (/^https:\/\/[^\s]+$/i.test(value)) return value;
    const normalized = value.replace(/^\.\//, "");
    const match = normalized.match(/^(?:\.\.\/)?assets\/([^/\\]+)$/i);
    if (!match || !base || !topicId || match[1] === "." || match[1] === "..") return null;
    return `${base}/assets/${encodeURIComponent(topicId)}/${encodeURIComponent(match[1])}`;
  }

  return { escapeHtml, inline, splitLongText, parseImageLine, renderMarkdownBlocks, paginateBlocks, resolveImageUrl };
});
