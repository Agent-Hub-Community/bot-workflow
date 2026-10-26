import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReleaseActivity } from '../prepare-release-activity.mjs';
import { joinGroups } from '../chat-groups.mjs';
import { chatrooms } from '../groups.example.mjs';
import { load } from '../../lib/newspaper-root.mjs';

const { startOf } = await load('lib/activity.mjs');

// Template placeholders stand in for the private chatroom usernames.
const groups = joinGroups(chatrooms);

for (const groupCount of [3, 4]) test(`release ranks ${groupCount} groups through day end and preserves historical three-group data`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const save = async (name, value) => {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const date = '2026-09-26', ids = Array.from({ length: groupCount }, (_, i) => `group-${i + 1}`);
  const historicalIds = ids.slice(0, 3);
  const issue = { id: date, date, pages: ids.map(id => ({ id })) };
  const oldIssue = { date: '2026-09-25', pages: historicalIds.map(id => ({ id })) };
  const rank = { leaders: [{ key: 'member-001', rank: 1 }] };
  const approved = {
    generatedAt: '2026-09-25T16:00:00Z',
    windows: Object.fromEntries(['week', 'month', 'all'].map(id => [id, { from: null, through: '2026-09-25' }])),
    ranks: { week: rank, month: rank, all: rank },
    groups: historicalIds.map(id => ({ id, first: '2026-09-25', last: '2026-09-25', available: true, daily: { '2026-09-25': rank } })),
    avatars: { 'member-001': 'avatars/member-001.jpg' },
  };
  await save('data/public-activity/snapshot.json', approved);
  await save('data/public-activity/avatars/member-001.jpg', Buffer.from('historical-image'));
  await save('batch/issues.json', [issue]);
  const cache = {};
  const contactPath = path.join(dir, 'contact.db');
  const contact = new DatabaseSync(contactPath);
  contact.exec('CREATE TABLE contact (username TEXT, small_head_url TEXT, big_head_url TEXT)');
  contact.prepare('INSERT INTO contact VALUES (?, ?, NULL)').run('person', 'https://wx.qlogo.cn/avatar');
  contact.close();
  cache['contact/contact.db'] = { path: contactPath };
  const usernames = groups.slice(0, groupCount).map(group => group.username);
  for (let shard = 0; shard < 2; shard++) {
    const file = path.join(dir, `message-${shard}.db`), db = new DatabaseSync(file);
    cache[`message/message_${shard}.db`] = { path: file };
    db.exec("CREATE TABLE Name2Id (user_name TEXT); INSERT INTO Name2Id VALUES ('person')");
    for (const username of usernames) {
      const table = `Msg_${createHash('md5').update(username).digest('hex')}`;
      db.exec(`CREATE TABLE ${table} (local_id INTEGER, server_id INTEGER, create_time INTEGER, local_type INTEGER, real_sender_id INTEGER, message_content TEXT, WCDB_CT_message_content INTEGER)`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, 1, 'text', 0)`);
      insert.run(1, 6691791431834355264n, startOf(date), 1);
      insert.run(2, 6691791431834355265n, startOf(date) + 86399, 3);
      insert.run(3, 6691791431834355266n, startOf(date) + 86400, 1);
      insert.run(4, 6691791431834355267n, startOf(date) + 5, 10000);
    }
    db.close();
  }
  await save('home/.wx-cli/cache/_mtimes.json', cache);
  for (const id of ids) await save(`batch/${date}/${id}.input.json`, {
    date, group: { id }, cutoff: '2026-09-26T16:00:00.000Z', coverage: { count: 3 },
  });
  let downloads = 0;
  const options = {
    home: path.join(dir, 'home'), root: pathToFileURL(dir + '/'), historicalIssues: [oldIssue], groups,
    fetchAvatar: async () => { downloads++; return new Response(Buffer.from([255, 216, 255, 0])); },
  };
  const result = await prepareReleaseActivity(path.join(dir, 'batch'), options);
  assert.equal(downloads, 1, 'same member across periods and groups fetched once');
  assert.equal(result.stats.ranks.week.counted, groupCount * 2);
  assert.equal(result.stats.ranks.week.raw, groupCount * 3);
  assert.equal(result.snapshot.groups.length, groupCount);
  for (const group of result.snapshot.groups) {
    assert.deepEqual(group.daily['2026-09-25'], group.id === 'group-4' ? undefined : rank);
    assert.equal(result.stats.daily[group.id].counted, 2);
    assert.equal(group.last, date);
  }
  for (const window of Object.values(result.snapshot.windows)) assert.equal(window.through, date);
  assert.deepEqual(await readFile(path.join(dir, 'batch/activity/avatars/member-001.jpg')), Buffer.from('historical-image'));
  assert.doesNotMatch(JSON.stringify(result.snapshot), /counted|participants|person|669179/);
  await save(`batch/${date}/group-3.input.json`, { date, group: { id: 'group-3' }, cutoff: '2026-09-26T16:00:00.000Z', coverage: { count: 4 } });
  await assert.rejects(prepareReleaseActivity(path.join(dir, 'batch'), options), /coverage differs/);
  assert.equal(downloads, 1, 'coverage mismatch aborts before fetching images');
});
