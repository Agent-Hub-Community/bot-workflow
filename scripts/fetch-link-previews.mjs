// Fetches OpenGraph / oEmbed link previews (title, description, siteName) for bare URLs in discussions
// and incrementally updates newspaper/data/link-previews.json. Fast, concurrent, never fails the pipeline
// on blocked/offline URLs.
//   node "$BOT/scripts/fetch-link-previews.mjs" [--batch BATCH_DIR] [--refresh-failed] [--concurrency 16]
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rootDir } from '../lib/newspaper-root.mjs';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const batchDir = opt('--batch');
const refreshFailed = args.includes('--refresh-failed');
const concurrency = Math.max(1, Math.min(32, Number(opt('--concurrency')) || 16));

const cacheFile = path.join(rootDir, 'data', 'link-previews.json');
const cache = existsSync(cacheFile) ? JSON.parse(await readFile(cacheFile, 'utf8')) : {};

function extractBareUrls(text) {
  const t = (text || '').trim();
  if (!t || t.startsWith('[链接]')) return [];
  const out = [];
  for (const match of t.matchAll(/https?:\/\/[^\s<>"'，。；！？、]+/g)) {
    let raw = match[0].replace(/[.,;!?]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['（', '）']]) {
      while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -1);
    }
    try {
      const url = new URL(raw);
      const privateQuery = [...url.searchParams.keys()].some(k => /token|key|auth|signature|session/i.test(k));
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !privateQuery) out.push(url.href);
    } catch {}
  }
  return out;
}

const urls = new Set();
const scanPages = pages => {
  for (const p of pages || []) for (const s of p.stories || []) for (const m of s.discussion || []) {
    for (const u of extractBareUrls(m.text)) urls.add(u);
  }
};

if (batchDir) {
  const issuesFile = path.join(path.resolve(batchDir), 'issues.json');
  if (existsSync(issuesFile)) {
    for (const ed of JSON.parse(await readFile(issuesFile, 'utf8'))) scanPages(ed.pages);
  }
} else {
  const edDir = path.join(rootDir, 'data', 'editions');
  for (const f of (await readdir(edDir)).filter(n => n.endsWith('.json'))) {
    scanPages(JSON.parse(await readFile(path.join(edDir, f), 'utf8')).pages);
  }
  const wkDir = path.join(rootDir, 'data', 'weekly-editions');
  if (existsSync(wkDir)) {
    for (const f of (await readdir(wkDir)).filter(n => n.endsWith('.json'))) {
      scanPages(JSON.parse(await readFile(path.join(wkDir, f), 'utf8')).pages);
    }
  }
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ENTITIES[m] || m)
    .replace(/\s+/g, ' ').trim();
}

const BAD_TITLE = /^(?:just a moment|attention required|access denied|403 forbidden|404|not found|page not found|error|cloudflare|verify you are human|sign in|log in|login|x\.com|twitter)/i;

function parseHtmlMeta(html) {
  const metas = new Map();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const raw = tag[0];
    const key = (raw.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    const content = (raw.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && content && !metas.has(key)) metas.set(key, decodeEntities(content));
  }
  const titleTag = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  let title = metas.get('citation_title') || metas.get('og:title') || metas.get('twitter:title') || titleTag;
  let description = metas.get('og:description') || metas.get('twitter:description') || metas.get('description') || '';
  let siteName = metas.get('og:site_name') || '';
  if (title && BAD_TITLE.test(title)) return null;
  if (!title) return null;
  // Clean GitHub boilerplate prefix/suffix for crisp cards.
  title = title.replace(/^GitHub\s*-\s*/i, '').replace(/\s*·\s*GitHub$/i, '').trim();
  description = description.replace(/\s*Contribute to [^\s]+ development by creating an account on GitHub\.?$/i, '').trim();
  return {
    title: title.slice(0, 160),
    ...(description && description !== title ? { description: description.slice(0, 220) } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 48) } : {}),
  };
}

async function fetchPreview(href) {
  const parsed = new URL(href);
  const host = parsed.hostname.replace(/^www\./, '');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  // X / Twitter status -> official oEmbed API
  if ((host === 'x.com' || host === 'twitter.com') && /\/status\/\d+/.test(parsed.pathname)) {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(href)}&omit_script=true`;
    const res = await fetch(oembedUrl, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const author = decodeEntities(data.author_name || '');
    const pText = decodeEntities(String(data.html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&mdash;.*$/, ''));
    if (!author && !pText) return null;
    return {
      title: author ? `${author} 的帖子` : 'X 帖子',
      ...(pText ? { description: pText.slice(0, 220) } : {}),
      siteName: 'X',
    };
  }

  // arXiv PDF -> fetch abstract page HTML instead of downloading PDF bytes!
  let target = href;
  if (host === 'arxiv.org' && parsed.pathname.startsWith('/pdf/')) {
    target = `https://arxiv.org/abs/${parsed.pathname.slice(5).replace(/\.pdf$/i, '')}`;
  }

  const res = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(7000) });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('html') && !ct.includes('xml')) return null;
  // Read only the first 96 KB (head metadata lives at the top).
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < 98304) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const html = Buffer.concat(chunks).toString('utf8');
  return parseHtmlMeta(html);
}

const pending = [...urls].filter(u => {
  const existing = cache[u];
  if (!existing) return true;
  if (refreshFailed && existing.failed) return true;
  return false;
});

let ok = 0, fail = 0, done = 0;
const queue = [...pending];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) {
    const href = queue.shift();
    try {
      const meta = await fetchPreview(href);
      if (meta) { cache[href] = meta; ok++; }
      else { cache[href] = { failed: true }; fail++; }
    } catch {
      cache[href] = { failed: true };
      fail++;
    }
    done++;
    if (done % 50 === 0 || done === pending.length) {
      console.log(`Progress ${done}/${pending.length} (ok=${ok}, skip=${fail})`);
    }
  }
}));

// Keep clean sorted cache (omit failed markers? Keep failed markers in cache so reruns don't retry dead links,
// while build.mjs strips `{ failed: true }` when publishing dist/link-previews.json!).
const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(cacheFile, JSON.stringify(sorted, null, 2) + '\n');
console.log(JSON.stringify({ totalUrls: urls.size, fetched: pending.length, ok, fail, cachedOk: Object.values(sorted).filter(v => v.title).length }));
