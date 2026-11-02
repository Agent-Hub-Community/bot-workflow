import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareWeeklyRank } from '../prepare-weekly-rank.mjs';
import { joinGroups } from '../chat-groups.mjs';
import { chatrooms } from '../groups.example.mjs';
import { load } from '../../lib/newspaper-root.mjs';
import { activityFixture, jpeg, placeholderAvatar } from './activity-fixture.mjs';

const { startOf } = await load('lib/activity.mjs');
const { weeklyGroups } = await load('lib/groups.mjs');

const groups = joinGroups(chatrooms);
const username = Object.fromEntries(groups.map(group => [group.id, group.username]));
const from = '2026-10-26', through = '2026-11-01';
const day = n => startOf(from) + n * 86400;

async function weeklyBatch(t, name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weekly-rank-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { home, root, save } = await activityFixture(dir, {
    historicalIds: ['group-1', 'group-2', 'group-3'], historicalDate: '2026-10-25',
    contacts: Object.fromEntries(['person', 'ghost', 'before', 'robot'].map(member => [member, `https://wx.qlogo.cn/${member}`])),
    messages: {
      [username['group-1']]: [
        // The busiest sender talked only the Sunday before the week, so a wrong window would rank them first.
        ...Array.from({ length: 5 }, (_, i) => [day(-1) + i, 1, 'before']),
        [day(0), 1, 'person'], [day(2), 1, 'person'], [day(6), 1, 'person'],
        [day(1), 1, 'ghost'], [day(1) + 1, 1, 'ghost'], [day(4), 1, 'lurker'], [day(7), 1, 'lurker'],
      ],
      [username['group-6']]: [[day(6) + 60, 1, 'robot']],
    },
  });
  const batch = path.join(dir, name);
  const ids = weeklyGroups(through).map(group => group.id);
  const sunday = { 'group-1': 1, 'group-6': 1 };
  for (const id of ids) await save(`${name}/${through}/${id}.input.json`, {
    date: through, group: { id }, cutoff: '2026-11-01T16:00:00.000Z', coverage: { count: sunday[id] || 0 },
  });
  await save(`${name}/reader/preview/avatars/stale.jpg`, Buffer.from('stale'));
  const historicalIssues = [{ date: '2026-10-25', pages: ['group-1', 'group-2', 'group-3'].map(id => ({ id })) }];
  const fetchAvatar = async url => new Response(String(url).endsWith('/ghost') ? placeholderAvatar : jpeg);
  return { batch, ids, options: { home, root, historicalIssues, groups, fetchAvatar } };
}

test('weekly ranking gives every weekly group, topical ones included, its own Monday-to-Sunday Top 3', async t => {
  const { batch, ids, options } = await weeklyBatch(t, `weekly-${from}_${through}-run1`);
  assert.ok(ids.includes('group-6') && ids.includes('group-8'));
  const { leaders } = await prepareWeeklyRank(batch, options);
  const key = member => leaders.find(leader => leader.group === member[0] && leader.rank === member[1]).key;
  const [person, ghost, lurker, robot] = [key(['group-1', 1]), key(['group-1', 2]), key(['group-1', 3]), key(['group-6', 1])];

  const rank = JSON.parse(await readFile(path.join(batch, 'rank.json'), 'utf8'));
  assert.deepEqual(rank.groups.map(group => [group.id, group.label]), groups.filter(group => ids.includes(group.id)).map(group => [group.id, group.label]));
  const byId = Object.fromEntries(rank.groups.map(group => [group.id, group.leaders]));
  assert.deepEqual(byId['group-1'], [
    { rank: 1, avatar: `avatars/${person}.jpg` }, { rank: 2, avatar: null }, { rank: 3, avatar: null },
  ]);
  assert.deepEqual(byId['group-6'], [{ rank: 1, avatar: `avatars/${robot}.jpg` }]);
  assert.deepEqual(byId['group-2'], []);

  assert.deepEqual((await readdir(path.join(batch, 'reader/preview/avatars'))).sort(), [`${person}.jpg`, `${robot}.jpg`].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(batch, 'rank-review.json'), 'utf8')), {
    pending: [`avatars/${person}.jpg`, `avatars/${robot}.jpg`].sort(),
    autoRejected: [{ group: 'group-1', rank: 2, key: ghost, reason: 'placeholder' }],
    failures: [{ group: 'group-1', rank: 3, key: lurker, reason: 'missing-contact-image' }],
  });
  const sourceFile = path.join(batch, 'rank-source.private.json');
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  assert.deepEqual(source.window, { from, through });
  assert.equal((await stat(sourceFile)).mode & 0o777, 0o600);
  // The private source keeps who each public key is after the temporary batch is gone; the public files never do.
  assert.deepEqual(source.leaders.map(({ group, rank, key, username }) => [group, rank, key, username]), [
    ['group-1', 1, person, 'person'], ['group-1', 2, ghost, 'ghost'], ['group-1', 3, lurker, 'lurker'], ['group-6', 1, robot, 'robot'],
  ]);
  assert.doesNotMatch(JSON.stringify(rank), /person|ghost|lurker|robot|chatroom/);
  assert.doesNotMatch(await readFile(path.join(batch, 'rank-review.json'), 'utf8'), /person|ghost|lurker|robot|chatroom/);
});

test('weekly ranking refuses a batch whose name is not a Monday-to-Sunday week', async t => {
  const { batch, options } = await weeklyBatch(t, 'weekly-2026-10-27_2026-11-02-run1');
  await assert.rejects(prepareWeeklyRank(batch, options), /Monday-to-Sunday/);
  await assert.rejects(prepareWeeklyRank(path.join(path.dirname(batch), 'weekly-run1'), options), /FROM_THROUGH/);
});
