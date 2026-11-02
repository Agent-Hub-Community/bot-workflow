import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareReleaseActivity } from '../prepare-release-activity.mjs';
import { joinGroups } from '../chat-groups.mjs';
import { chatrooms } from '../groups.example.mjs';
import { load } from '../../lib/newspaper-root.mjs';
import { activityFixture, jpeg, placeholderAvatar } from './activity-fixture.mjs';

const { startOf } = await load('lib/activity.mjs');

// Template placeholders stand in for the private chatroom usernames.
const groups = joinGroups(chatrooms);
const date = '2026-09-26';
const oldIssue = { date: '2026-09-25', pages: ['group-1', 'group-2', 'group-3'].map(id => ({ id })) };
const rank = { leaders: [{ key: 'member-001', rank: 1 }] };

for (const groupCount of [3, 4]) test(`release ranks ${groupCount} groups through day end and preserves historical three-group data`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = Array.from({ length: groupCount }, (_, i) => `group-${i + 1}`);
  const day = startOf(date);
  const { home, root, save } = await activityFixture(dir, {
    historicalIds: ids.slice(0, 3), historicalDate: '2026-09-25',
    contacts: { person: 'https://wx.qlogo.cn/avatar' },
    messages: Object.fromEntries(groups.slice(0, groupCount).map(group => [group.username, [
      [day, 1, 'person'], [day + 86399, 3, 'person'], [day + 86400, 1, 'person'], [day + 5, 10000, 'person'],
    ]])),
  });
  await save('batch/issues.json', [{ id: date, date, pages: ids.map(id => ({ id })) }]);
  for (const id of ids) await save(`batch/${date}/${id}.input.json`, {
    date, group: { id }, cutoff: '2026-09-26T16:00:00.000Z', coverage: { count: 3 },
  });
  let downloads = 0;
  const options = {
    home, root, historicalIssues: [oldIssue], groups,
    fetchAvatar: async () => { downloads++; return new Response(jpeg); },
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

test('a WeChat placeholder avatar is rejected without review and the rank stays', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = ['group-1', 'group-2', 'group-3'], day = startOf(date);
  const { home, root, save } = await activityFixture(dir, {
    historicalIds: ids, historicalDate: '2026-09-25',
    contacts: { person: 'https://wx.qlogo.cn/person', ghost: 'https://wx.qlogo.cn/ghost' },
    messages: { [groups[0].username]: [[day, 1, 'person'], [day + 1, 1, 'person'], [day + 2, 1, 'ghost']] },
  });
  await save('batch/issues.json', [{ id: date, date, pages: ids.map(id => ({ id })) }]);
  for (const id of ids) await save(`batch/${date}/${id}.input.json`, {
    date, group: { id }, cutoff: '2026-09-26T16:00:00.000Z', coverage: { count: id === 'group-1' ? 3 : 0 },
  });
  const result = await prepareReleaseActivity(path.join(dir, 'batch'), {
    home, root, historicalIssues: [oldIssue], groups,
    fetchAvatar: async url => new Response(String(url).endsWith('/ghost') ? placeholderAvatar : jpeg),
  });
  const [first, second] = result.snapshot.ranks.week.leaders;
  assert.deepEqual([first.rank, second.rank], [1, 2]);
  assert.deepEqual(result.autoRejected, [{ key: second.key, reason: 'placeholder' }]);
  assert.equal(result.snapshot.avatars[second.key], undefined);
  assert.equal(result.snapshot.avatars[first.key], `avatars/${first.key}.jpg`);
  assert.deepEqual(result.failures, []);
  const review = JSON.parse(await readFile(path.join(dir, 'batch/activity/avatar-review.json'), 'utf8'));
  assert.deepEqual(review, { pending: [`avatars/${first.key}.jpg`], failures: [], autoRejected: [{ key: second.key, reason: 'placeholder' }] });
  assert.ok(!(await readdir(path.join(dir, 'batch/activity/avatars'))).some(name => name.startsWith(second.key)));
});
