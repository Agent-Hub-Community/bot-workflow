import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { load } from '../lib/newspaper-root.mjs';
import { chatGroups } from './chat-groups.mjs';
import { prepareReleaseActivity } from './prepare-release-activity.mjs';

const { weeklyGroups } = await load('lib/groups.mjs');

// Per-group Top 3 of one calendar week for the weekly edition, topical groups included.
//   WX_ACTIVITY_HOME=... node "$PIPELINE/prepare-weekly-rank.mjs" WEEKLY_BATCH
// WEEKLY_BATCH is scratch/weekly-FROM_THROUGH-runN with THROUGH/<group>.input.json for every weekly group.
// Writes rank.json, reader/preview/avatars/, rank-review.json and rank-source.private.json into WEEKLY_BATCH;
// data/public-activity/ is only read.
export async function prepareWeeklyRank(batch, { groups, ...options } = {}) {
  const match = /(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/.exec(path.basename(path.resolve(batch)));
  assert.ok(match, 'WEEKLY_BATCH name must contain FROM_THROUGH');
  const [, from, through] = match;
  const start = Date.parse(`${from}T00:00:00Z`);
  assert.ok(new Date(start).getUTCDay() === 1 && Date.parse(`${through}T00:00:00Z`) - start === 6 * 86400000,
    `Weekly ranking needs a Monday-to-Sunday window, got ${from}..${through}`);
  groups ??= await chatGroups();
  const ids = weeklyGroups(through).map(group => group.id);
  // The release ranking only ranks groups that have a page and are not optional; a Sunday-only pseudo batch that
  // gives every weekly group a page makes its week window cover exactly FROM..THROUGH for each of them.
  const work = await mkdtemp(path.join(tmpdir(), 'weekly-rank-'));
  try {
    await writeFile(path.join(work, 'issues.json'), JSON.stringify([{ id: through, date: through, pages: ids.map(id => ({ id })) }]));
    await mkdir(path.join(work, through));
    for (const id of ids) await copyFile(path.join(batch, through, `${id}.input.json`), path.join(work, through, `${id}.input.json`));
    // The pseudo batch also ranks the community and every group's other periods, so prepareReleaseActivity downloads
    // their avatars too although the weekly edition only uses each group's week Top 3. Reusing it unchanged costs at
    // most about a hundred extra downloads, each bounded by its 12-second timeout.
    const result = await prepareReleaseActivity(work, { ...options, groups: groups.map(group => ({ ...group, optionalPage: false })) });
    const { snapshot } = result;
    assert.deepEqual(snapshot.windows.week, { from, through }, 'Weekly ranking window differs from the batch name');

    const labels = Object.fromEntries(groups.map(group => [group.id, group.label]));
    // private-audit.json maps WeChat username -> member-NNN; invert it so the private source keeps who each leader is
    // after the work copy is deleted.
    const audit = JSON.parse(await readFile(path.join(work, 'activity', 'private-audit.json'), 'utf8'));
    const usernames = new Map(Object.entries(audit.mapping).map(([username, key]) => [key, username]));
    const leaders = ids.flatMap(id => snapshot.groups.find(group => group.id === id).ranks.week.leaders
      .map(({ key, rank }) => ({ group: id, rank, key, avatar: snapshot.avatars[key] ?? null })));
    const rank = { groups: ids.map(id => ({ id, label: labels[id],
      leaders: leaders.filter(leader => leader.group === id).map(({ rank, avatar }) => ({ rank, avatar })) })) };

    // The preview folder holds only this ranking's avatars, so a rerun replaces them.
    const avatarDir = path.join(batch, 'reader/preview/avatars');
    await rm(avatarDir, { recursive: true, force: true });
    await mkdir(avatarDir, { recursive: true });
    const files = [...new Set(leaders.map(leader => leader.avatar).filter(Boolean))].sort();
    for (const file of files) await copyFile(path.join(work, 'activity', file), path.join(batch, 'reader/preview', file));

    const reasons = list => new Map(list.map(({ key, reason }) => [key, reason]));
    const rejected = reasons(result.autoRejected), failed = reasons(result.failures);
    const review = {
      pending: files.filter(file => result.pending.includes(file)),
      autoRejected: leaders.filter(leader => rejected.has(leader.key)).map(({ group, rank, key }) => ({ group, rank, key, reason: rejected.get(key) })),
      failures: leaders.filter(leader => failed.has(leader.key)).map(({ group, rank, key }) => ({ group, rank, key, reason: failed.get(key) })),
    };
    await writeFile(path.join(batch, 'rank.json'), JSON.stringify(rank, null, 2) + '\n');
    await writeFile(path.join(batch, 'rank-review.json'), JSON.stringify(review, null, 2) + '\n');
    await writeFile(path.join(batch, 'rank-source.private.json'), JSON.stringify({
      window: { from, through }, generatedAt: snapshot.generatedAt,
      method: `prepareReleaseActivity with ${ids.length} weekly groups sectioned; groups[].ranks.week top3`,
      leaders: leaders.map(leader => {
        assert.ok(usernames.has(leader.key), `${leader.key} is missing from private-audit.json mapping`);
        return { ...leader, username: usernames.get(leader.key) };
      }),
    }, null, 2) + '\n', { mode: 0o600 });
    return { rank, review, leaders };
  } finally {
    // The work copy holds private audit data (member usernames), so it never outlives the run.
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Usage: node prepare-weekly-rank.mjs WEEKLY_BATCH');
  const { review } = await prepareWeeklyRank(path.resolve(process.argv[2]));
  console.log(JSON.stringify(review, null, 2));
}
