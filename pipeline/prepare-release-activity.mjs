import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { load, root as newspaperRoot } from '../lib/newspaper-root.mjs';
import { chatGroups } from './chat-groups.mjs';

const { dayOf, startOf, memberKey, deduplicate, summarize } = await load('lib/activity.mjs');
const { validatePublicActivity } = await load('lib/public-activity.mjs');
const { digests } = await load('lib/digest.mjs');

// Reads the approved data/public-activity/ snapshot of the newspaper checkout; writes only to BATCH/activity/.
//   WX_ACTIVITY_HOME=... node "$PIPELINE/prepare-release-activity.mjs" BATCH
export async function prepareReleaseActivity(batch, {
  home = process.env.WX_ACTIVITY_HOME, root = newspaperRoot, fetchAvatar = fetch,
  historicalIssues = digests, groups: allGroups,
} = {}) {
assert.ok(batch && home, 'Provide batch and verified WX_ACTIVITY_HOME');
allGroups ??= await chatGroups();
const issues = JSON.parse(await readFile(path.join(batch, 'issues.json'), 'utf8'));
assert.equal(issues.length, 1, 'Release collector expects one day');
const date = issues[0].date, end = startOf(date) + 86400;
const cache = JSON.parse(await readFile(path.join(home, '.wx-cli/cache/_mtimes.json'), 'utf8'));
const approved = JSON.parse(await readFile(new URL('data/public-activity/snapshot.json', root), 'utf8'));
// Every group that existed by this date feeds the community ranking, including ones that do not
// have a reader section yet; per-group columns and daily ranks stay with the sectioned groups.
// Groups the edition itself carries are always ranked, even if they predate their recorded start.
const sectionedIds = new Set(issues[0].pages.map(page => page.id));
const knownGroups = allGroups.filter(group => sectionedIds.has(group.id) || !group.from || group.from <= date);
const groups = knownGroups.filter(group => sectionedIds.has(group.id));
assert.ok(groups.length, 'Release has no group pages');
assert.ok(approved.groups.every(group => groups.some(current => current.id === group.id)), 'Release cannot drop an existing activity group');
let rows = [];
for (const [source, entry] of Object.entries(cache).filter(([s]) => /^message\/message_\d+\.db$/.test(s))) {
  const db = new DatabaseSync(entry.path, { readOnly: true });
  try {
    for (const { id, username } of knownGroups) {
      const table = `Msg_${createHash('md5').update(username).digest('hex')}`;
      if (!db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(table)) continue;
      rows.push(...db.prepare(`SELECT m.local_id AS local, CAST(m.server_id AS TEXT) AS server,
        m.create_time AS timestamp, m.local_type AS type, n.user_name AS sender,
        m.message_content AS content, m.WCDB_CT_message_content AS compressed
        FROM ${table} m LEFT JOIN Name2Id n ON n.rowid = m.real_sender_id
        WHERE m.create_time < ?`).all(end).map(row => ({ ...row, group: id, shard: source })));
    }
  } finally { db.close(); }
}
rows = deduplicate(rows);
const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
const bounds = { week: startOf(date) - ((weekday + 6) % 7) * 86400, month: startOf(`${date.slice(0, 7)}-01`), all: 0 };
const stats = { ranks: Object.fromEntries(Object.entries(bounds).map(([id, start]) => [id, summarize(rows, start, end)])), daily: {} };
const groupStats = Object.fromEntries(groups.map(({ id }) => [id,
  Object.fromEntries(Object.entries(bounds).map(([period, start]) => [
    period, summarize(rows.filter(row => row.group === id), start, end),
  ])),
]));
for (const { id } of groups) {
  const input = JSON.parse(await readFile(path.join(batch, date, `${id}.input.json`), 'utf8'));
  assert.equal(input.date, date);
  assert.equal(input.group.id, id);
  assert.equal(input.cutoff, new Date(end * 1000).toISOString());
  const daily = summarize(rows.filter(row => row.group === id), startOf(date), end);
  assert.equal(daily.raw, input.coverage.count, `${id} coverage differs from reviewed editorial input`);
  stats.daily[id] = daily;
}
const out = path.join(batch, 'activity');
await mkdir(path.join(out, 'avatars'), { recursive: true, mode: 0o700 });
const snapshot = structuredClone(approved);
for (const { id } of groups) {
  if (!snapshot.groups.some(group => group.id === id)) {
    snapshot.groups.push({ id, available: false, first: null, last: null, ranks: {}, daily: {} });
  }
}
snapshot.generatedAt = new Date(end * 1000).toISOString();
snapshot.windows = Object.fromEntries(Object.entries(bounds).map(([id, start]) => [id, { from: start ? dayOf(start) : null, through: date }]));
// Keep historical daily keys and images verbatim; new identities use an unused public key.
const keys = new Set([...Object.keys(approved.avatars), ...Object.values(approved.ranks).flatMap(s => s.leaders.map(m => m.key)),
  ...approved.groups.flatMap(g => Object.values(g.daily).flatMap(s => s.leaders.map(m => m.key)))]);
let serial = Math.max(0, ...[...keys].map(key => Number(key.slice(7))));
const mapping = new Map(), pending = [], failures = [];
const contact = new DatabaseSync(cache['contact/contact.db'].path, { readOnly: true });
const identities = new Map(rows.filter(r => r.sender).map(r => [memberKey(r.sender), r.sender]));
try {
for (const stat of [
  ...Object.values(stats.ranks),
  ...Object.values(stats.daily),
  ...Object.values(groupStats).flatMap(group => Object.values(group)),
]) {
    for (const member of stat.leaders.slice(0, 3)) {
      if (mapping.has(member.key)) continue;
      const key = `member-${String(++serial).padStart(3, '0')}`;
      mapping.set(member.key, key);
      const person = contact.prepare('SELECT small_head_url, big_head_url FROM contact WHERE username = ?').get(identities.get(member.key));
      const raw = person?.small_head_url || person?.big_head_url;
      if (!raw) { failures.push({ key, reason: 'missing-contact-image' }); continue; }
      try {
        const url = new URL(raw);
        assert.ok(['http:', 'https:'].includes(url.protocol) && (/(^|\.)qlogo\.cn$/.test(url.hostname) || url.hostname === 'mmhead.c2c.wechat.com'));
        url.protocol = 'https:';
        const response = await fetchAvatar(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
        assert.ok(response.ok, `HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const ext = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png' : null;
        assert.ok(ext && bytes.length < 2_000_000, 'Invalid image');
        const file = `avatars/${key}.${ext}`;
        await writeFile(path.join(out, file), bytes, { mode: 0o600 });
        snapshot.avatars[key] = file;
        pending.push(file);
      } catch (error) { failures.push({ key, reason: error.message }); }
    }
  }
} finally { contact.close(); }
const ranking = stat => ({ leaders: stat.leaders.slice(0, 3).map(m => ({ key: mapping.get(m.key), rank: m.rank })) });
snapshot.ranks = Object.fromEntries(Object.entries(stats.ranks).map(([id, stat]) => [id, ranking(stat)]));
for (const group of snapshot.groups) {
  if (groupStats[group.id]) {
    group.ranks = Object.fromEntries(Object.entries(groupStats[group.id]).map(([period, stat]) => [period, ranking(stat)]));
    group.daily[date] = ranking(stats.daily[group.id]);
  }
  const own = rows.filter(r => r.group === group.id);
  group.available = own.length > 0;
  group.first = own.length ? dayOf(Math.min(...own.map(r => r.timestamp))) : null;
  group.last = own.length ? dayOf(Math.max(...own.map(r => r.timestamp))) : null;
}
const used = new Set([...Object.values(snapshot.ranks), ...snapshot.groups.flatMap(g => [...Object.values(g.daily), ...Object.values(g.ranks || {})])].flatMap(s => s.leaders.map(m => m.key)));
for (const key of Object.keys(snapshot.avatars)) if (!used.has(key)) delete snapshot.avatars[key];
for (const [key, file] of Object.entries(approved.avatars)) {
  if (snapshot.avatars[key]) await copyFile(new URL(`data/public-activity/${file}`, root), path.join(out, file));
}
validatePublicActivity(snapshot, [...historicalIssues.filter(issue => issue.date !== date), ...issues]);
for (const group of approved.groups) {
  for (const [day, stat] of Object.entries(group.daily)) {
    if (day !== date) assert.deepEqual(snapshot.groups.find(g => g.id === group.id).daily[day], stat);
  }
}
await writeFile(path.join(out, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
await writeFile(path.join(out, 'avatar-review.json'), JSON.stringify({ pending, failures }, null, 2));
await writeFile(path.join(out, 'private-audit.json'), JSON.stringify({ date, stats, mapping: Object.fromEntries(mapping), coverage: `${groups.length} groups; local retained history only` }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ date, counts: Object.fromEntries(Object.entries(stats.daily).map(([id, stat]) => [id, stat.raw])), pending, failures }, null, 2));
return { snapshot, stats, pending, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareReleaseActivity(process.argv[2]);
}
