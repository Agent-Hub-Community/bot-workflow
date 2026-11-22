const URL_PATTERN = /https?:\/\/[^\s<>"'\u3000\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff08\uff09\u3010\u3011]+/giu;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function extractLinks(content) {
  const text = String(content ?? '');
  const links = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0].replace(/[.,;!]+$/, '');
    // Remove prose/Markdown closing delimiters only when they are unbalanced.
    for (const [open, close] of [['(', ')'], ['[', ']']]) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
    }
    const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
    let label = text.slice(lineStart, match.index).replace(URL_PATTERN, '').trim();
    const markdown = label.match(/\[([^\]]+)\]\($/);
    if (markdown) label = markdown[1];
    if (/^(?:URL|link)?\s*[:\uff1a]?$/i.test(label)) {
      label = text.match(/^\[\u94fe\u63a5\]\s*(.+)$/m)?.[1] || '';
    }
    links.push({ url, link_text: clean(label.replace(/[:\uff1a\s]+$/, '')).slice(0, 160) });
  }
  return links;
}
