// Lists links shared in the group chats so an editor can review them for the library.
// Reads private chat inputs; the output carries chat context and must stay in scratch/ of the newspaper checkout
// (ignored by git).
//   WX_ACTIVITY_HOME=/path/to/account-home node "$PIPELINE/collect-library-candidates.mjs" [--since YYYY-MM-DD] [--out FILE]
// With WX_ACTIVITY_HOME, each share also records its sender as a member hash and the contact avatar URL,
// read from the decrypted cache the activity scripts use. WeChat IDs are not written. The output also lists the
// operator hashes from groups.private.mjs, which the public assemble-library.mjs treats as relays.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';
import { extractLinks } from '../scripts/package-month-resources.mjs';
import { load, rootDir as root } from '../lib/newspaper-root.mjs';
import { loadChatDays } from './chat-days.mjs';
import { chatGroups } from './chat-groups.mjs';

const { GROUPS, canonicalUrl, resourceKey, readLibrary } = await load('lib/library.mjs');

const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const since = option('--since') || '0000-00-00';
const out = path.resolve(option('--out') || path.join(root, 'scratch/library/candidates.json'));
if (!out.startsWith(path.join(root, 'scratch') + path.sep)) throw new Error('Candidates contain chat context; write them under scratch/ of the newspaper checkout');

// Links that are never library material, whatever the context. Own-site covers the current site
// (agent-hub-community.github.io/newspaper/) and the old one (hqhq1025.github.io/agent_hub/).
const excluded = [
  [/^https:\/\/(?:agent-hub-community|hqhq1025)\.github\.io\//, 'own-site'],
  [/^https:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.c(?:om|n))\//, 'xiaohongshu-share'],
  [/^https:\/\/(?:meet\.google\.com|(?:[\w-]+\.)?zoom\.us|meeting\.tencent\.com|vc\.feishu\.cn)\//, 'meeting'],
  [/^https:\/\/(?:forms\.gle|docs\.google\.com\/forms|wj\.qq\.com|(?:[\w-]+\.)?jinshuju\.(?:net|com))\//, 'form'],
  [/\.(?:png|jpe?g|gif|webp|mp4|mov)$/i, 'media-file'],
];

const short = (text, limit = 220) => {
  // Slice by code point so emoji are never split into lone surrogates.
  const value = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return value.length > limit ? `${value.slice(0, limit).join('')}…` : value.join('');
};
const card = content => {
  const match = String(content).match(/^\[链接\]\s*(.+)$/m);
  if (!match) return null;
  const field = name => String(content).match(new RegExp(`^\\s*${name}[:：]\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
  return { title: match[1].trim(), source: field('来源'), summary: field('摘要') };
};

const { days, dailyInputs, firstDaily } = await loadChatDays(root, { since });

const published = new Map();
for (const name of (await readdir(path.join(root, 'data/editions'))).filter(name => name.endsWith('.json'))) {
  const issue = JSON.parse(await readFile(path.join(root, 'data/editions', name), 'utf8'));
  for (const page of issue.pages) for (const story of page.stories || []) for (const resource of story.resources || []) {
    const key = resourceKey(resource.url);
    if (!published.has(key)) published.set(key, []);
    published.get(key).push({ date: issue.date, group: page.id, story: story.title, label: resource.label, kind: resource.kind, url: resource.url });
  }
}
const library = await readLibrary(path.join(root, 'data')).catch(error => { if (error.code === 'ENOENT') return { items: [] }; throw error; });
const curated = new Set(library.items.flatMap(item => [...item.links.map(link => link.url), ...(item.aliases || [])].map(resourceKey)));

const chatrooms = Object.fromEntries((await chatGroups()).map(group => [group.id, group.username]));
const members = {};
const senderIds = new Map();
let resolveSender = () => null, closeCache = () => {};
if (process.env.WX_ACTIVITY_HOME) {
  const { DatabaseSync } = await import('node:sqlite');
  const cache = JSON.parse(await readFile(path.join(process.env.WX_ACTIVITY_HOME, '.wx-cli/cache/_mtimes.json'), 'utf8'));
  const shards = Object.entries(cache).filter(([name]) => /^message\/message_\d+\.db$/.test(name))
    .map(([, entry]) => new DatabaseSync(entry.path, { readOnly: true }));
  const contact = new DatabaseSync(cache['contact/contact.db'].path, { readOnly: true });
  const decode = row => {
    try {
      const text = typeof row.content === 'string' ? row.content
        : (row.compressed === 4 ? zstdDecompressSync(row.content) : Buffer.from(row.content)).toString('utf8');
      return text.replaceAll('&amp;', '&');
    } catch { return ''; }
  };
  // The export rounds times to the minute, so a share is the message in that minute whose body holds the link.
  resolveSender = (group, date, time, raw) => {
    const table = `Msg_${createHash('md5').update(chatrooms[group]).digest('hex')}`;
    const start = Date.parse(`${date}T${time}:00+08:00`) / 1000;
    let needle;
    try { const url = new URL(raw); needle = decodeURI(url.host + url.pathname).replace(/\/$/, '').slice(0, 60); } catch { return null; }
    const senders = new Set();
    for (const db of shards) {
      if (!db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table)) continue;
      for (const row of db.prepare(`SELECT n.user_name AS sender, m.message_content AS content, m.WCDB_CT_message_content AS compressed
        FROM ${table} m LEFT JOIN Name2Id n ON n.rowid = m.real_sender_id WHERE m.create_time >= ? AND m.create_time < ?`).all(start, start + 60)) {
        // A reply embeds the message it quotes; only the replier's own text counts as sharing.
        const text = decode(row).replace(/<refermsg>[\s\S]*?<\/refermsg>/g, '');
        // Some rows lack a Name2Id link; group message bodies still start with "sender:\n".
        const sender = row.sender || text.match(/^([\w-]+):\n/)?.[1];
        if (sender && !sender.endsWith('@chatroom') && text.includes(needle)) senders.add(sender);
      }
    }
    if (senders.size !== 1) return null;
    const [username] = senders;
    if (!senderIds.has(username)) senderIds.set(username, `sharer-${String(senderIds.size + 1).padStart(3, '0')}`);
    const key = senderIds.get(username);
    if (!members[key]) {
      const person = contact.prepare('SELECT small_head_url, big_head_url FROM contact WHERE username = ?').get(username);
      members[key] = { avatarUrl: person?.small_head_url || person?.big_head_url || null };
    }
    return key;
  };
  closeCache = () => { for (const db of [...shards, contact]) db.close(); };
}

const candidates = new Map();
let truncated = 0, resolved = 0, unresolved = 0;
// The library only records shares from the groups it shows (lib/library.mjs GROUPS); a newer group without a reader
// section is collected for the daily ranking but stays out of the library until it gets one.
for (const day of days.filter(day => GROUPS[day.group])) {
  day.messages.forEach((message, index) => {
    for (const { url: raw } of extractLinks(message.content)) {
      if (/\.\.\.|…/.test(raw)) { truncated++; continue; }
      let url;
      try { url = canonicalUrl(raw); } catch { continue; }
      const key = resourceKey(url);
      if (!candidates.has(key)) candidates.set(key, {
        key, url, urls: [], exclude: excluded.find(([pattern]) => pattern.test(url))?.[1] || null,
        curated: curated.has(key), published: published.get(key) || [], shares: [],
      });
      const candidate = candidates.get(key);
      if (!candidate.urls.includes(url)) candidate.urls.push(url);
      const context = day.messages.slice(Math.max(0, index - 3), index + 4)
        .filter(other => other !== message && other.speaker && !/^\[(?:表情|图片|视频|语音|系统)\]/.test(other.content))
        .map(other => `${other.speaker} ${other.time}: ${short(other.content, 160)}`);
      // A link inside a quoted reply was shared by the quoted author, whose original message is recorded on its own.
      const quoteAt = message.content.indexOf('↳');
      const quoted = quoteAt >= 0 && message.content.indexOf(raw) > quoteAt;
      const sender = quoted ? null : resolveSender(day.group, day.date, message.time, raw);
      if (!quoted && process.env.WX_ACTIVITY_HOME) sender ? resolved++ : unresolved++;
      candidate.shares.push({ date: day.date, group: day.group, time: message.time, source: day.source,
        ...(quoted ? { quoted: true } : {}), ...(sender ? { sender } : {}),
        card: card(message.content), message: short(message.content, 600), context });
    }
  });
}

// Editors sometimes linked a work the chat only named; the published story is then the share record.
for (const [key, stories] of published) {
  if (candidates.has(key) || stories.every(story => story.date < since)) continue;
  candidates.set(key, { key, url: canonicalUrl(stories[0].url),
    urls: [], exclude: null, curated: curated.has(key), published: stories,
    shares: stories.map(story => ({ date: story.date, group: story.group, source: 'published-story', story: story.story, label: story.label })) });
}

closeCache();
const list = [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, `${JSON.stringify({ since, generatedFrom: { dailyInputs, firstDaily, through: days.map(day => day.date).sort().at(-1) }, candidates: list, members }, null, 2)}\n`, { mode: 0o600 });
const count = filter => list.filter(filter).length;
console.log(JSON.stringify({
  out: path.relative(root, out), days: days.length, candidates: list.length, truncatedSkipped: truncated,
  autoExcluded: Object.fromEntries(excluded.map(([, reason]) => [reason, count(item => item.exclude === reason)])),
  alreadyCurated: count(item => item.curated), toReview: count(item => !item.exclude && !item.curated),
  publishedInDaily: count(item => item.published.length),
  ...(process.env.WX_ACTIVITY_HOME ? { sharesWithSender: resolved, sharesWithoutSender: unresolved, members: Object.keys(members).length } : {}),
}, null, 2));
