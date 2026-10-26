// Lists hiring posts, events and calls for papers shared in the group chats, for review into the newspaper's data/opportunities.json.
// Many arrive as plain text without a link, so this reads message text, not only links. Reads private chat inputs;
// the output carries chat text and must stay in scratch/ of the newspaper checkout (ignored by git).
//   node "$PIPELINE/collect-opportunity-candidates.mjs" [--since YYYY-MM-DD] [--out FILE]
// Review follows the newspaper's OPPORTUNITY_REVIEW.md; merge the reviewed file with its scripts/assemble-opportunities.mjs.
// The posting test (looksLikePosting) is public in the newspaper's lib/opportunities.mjs, with its tests.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLinks } from '../scripts/package-month-resources.mjs';
import { load, rootDir as root } from '../lib/newspaper-root.mjs';
import { loadChatDays } from './chat-days.mjs';

const { canonicalUrl, resourceKey } = await load('lib/library.mjs');
const { OFFER, looksLikePosting } = await load('lib/opportunities.mjs');

const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const since = option('--since') || '0000-00-00';
const out = path.resolve(option('--out') || path.join(root, 'scratch/opportunities/candidates.json'));
if (!out.startsWith(path.join(root, 'scratch') + path.sep)) throw new Error('Candidates contain chat text; write them under scratch/ of the newspaper checkout');

const short = (text, limit) => {
  const value = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return value.length > limit ? `${value.slice(0, limit).join('')}…` : value.join('');
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { days } = await loadChatDays(root, { since });
  const candidates = new Map();
  for (const day of days) for (const message of day.messages) {
    if (!looksLikePosting(message.content)) continue;
    const own = message.content.split('↳')[0];
    const links = extractLinks(own).map(({ url }) => { try { return canonicalUrl(url); } catch { return null; } }).filter(Boolean);
    // The same posting relayed to several groups is one candidate: keyed by its first link, else its opening text.
    const key = links.length ? resourceKey(links[0]) : `text:${short(own, 60).replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40)}`;
    if (!candidates.has(key)) candidates.set(key, { key, links: [], shares: [] });
    const candidate = candidates.get(key);
    for (const link of links) if (!candidate.links.includes(link)) candidate.links.push(link);
    candidate.shares.push({ date: day.date, group: day.group, time: message.time, message: short(message.content, 800) });
  }
  // Link cards announcing an event or a call often carry the offer only in their card title; the library review
  // excluded those as promo, so they come over from its candidates when that file covers this window.
  const library = await readFile(path.join(root, 'scratch/library/candidates.json'), 'utf8').then(JSON.parse, () => ({ candidates: [] }));
  const reviewed = await readdir(path.join(root, 'scratch/library/curated')).catch(() => []);
  const promo = new Set();
  for (const name of reviewed.filter(name => name.endsWith('.json'))) {
    const batch = JSON.parse(await readFile(path.join(root, 'scratch/library/curated', name), 'utf8'));
    for (const entry of batch.excluded || []) if (entry.reason === 'promo') promo.add(entry.key);
  }
  for (const candidate of library.candidates) {
    const card = candidate.shares?.find(share => share.card)?.card;
    if (!promo.has(candidate.key) && !OFFER.test(card?.title || '')) continue;
    // Keyed the same way as the text scan, so a link it already found merges instead of appearing twice.
    const key = resourceKey(candidate.url);
    const shares = (candidate.shares || []).filter(share => share.date >= since && share.date && share.group)
      .map(share => ({ date: share.date, group: share.group, time: share.time, message: short(share.message || share.card?.title || '', 800) }));
    if (!shares.length) continue;
    if (!candidates.has(key)) candidates.set(key, { key, links: [canonicalUrl(candidate.url)], shares: [], from: 'library-promo' });
    const known = new Set(candidates.get(key).shares.map(share => `${share.date}/${share.group}/${share.time}`));
    candidates.get(key).shares.push(...shares.filter(share => !known.has(`${share.date}/${share.group}/${share.time}`)));
  }
  const list = [...candidates.values()].sort((a, b) => a.shares[0].date.localeCompare(b.shares[0].date));
  await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, `${JSON.stringify({ since, through: days.map(day => day.date).sort().at(-1), candidates: list }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ out: path.relative(root, out), days: days.length, candidates: list.length,
    withLinks: list.filter(item => item.links.length).length }, null, 2));
}
