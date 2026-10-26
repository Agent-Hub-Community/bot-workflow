import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkEdition, pageGroupIds, parseData } from './verify-publication.mjs';

// The same shape as newspaper/lib/groups.mjs: a group starts collection at `from` and its reader section at `pageFrom`.
const GROUPS_MODULE = `
export const groups = [
  { id: 'group-1', label: '一群', from: null, page: true },
  { id: 'group-2', label: '二群', from: null, page: true },
  { id: 'group-3', label: '三群', from: '2026-09-30', page: true },
  { id: 'group-4', label: '四群', from: '2026-10-16', page: true, pageFrom: '2026-10-20' },
  { id: 'group-5', label: '五群', from: '2026-10-01', page: false },
];
export const collectedGroups = date => groups.filter(group => !group.from || group.from <= date);
export const pageGroups = date => collectedGroups(date).filter(group => group.page && (!group.pageFrom || group.pageFrom <= date));
`;

async function withNewspaper(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'verify-publication-'));
  try {
    await mkdir(path.join(root, 'lib'));
    await writeFile(path.join(root, 'lib/groups.mjs'), GROUPS_MODULE);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const date = '2026-10-01';
const twoGroups = ['group-1', 'group-2'];
function fixture(date = '2026-10-01', groups = twoGroups) {
  return {
    publicBuild: true,
    digests: [{ date, pages: [...groups, 'external'].map(id => ({
      id, stories: [{ title: 'Title', text: 'Body', aiComment: 'Comment', feedbackId: 'a'.repeat(32) }],
    })) }],
    activity: {
      windows: Object.fromEntries(['week', 'month', 'all'].map(p => [p, { through: date }])),
      groups: groups.map(id => ({ id, daily: { [date]: { leaders: [] } } })),
    },
  };
}

test('parses generated JSON without executing JavaScript', () => {
  assert.deepEqual(parseData(`window.AGENT_HUB_DATA = ${JSON.stringify(fixture())};\n`), fixture());
  assert.throws(() => parseData('window.AGENT_HUB_DATA = (() => { throw "executed"; })();'));
});

test('expected sections follow from and pageFrom in lib/groups.mjs without backfilling history', () => withNewspaper(async root => {
  assert.deepEqual(await pageGroupIds(root, '2026-09-29'), ['group-1', 'group-2']);
  assert.deepEqual(await pageGroupIds(root, '2026-09-30'), ['group-1', 'group-2', 'group-3']);
  // Collected from 10-16 but without a reader section until 10-20; a page: false group never has one.
  assert.deepEqual(await pageGroupIds(root, '2026-10-19'), ['group-1', 'group-2', 'group-3']);
  assert.deepEqual(await pageGroupIds(root, '2026-10-20'), ['group-1', 'group-2', 'group-3', 'group-4']);
}));

test('a group that joins requires its section and daily ranking from that date on', () => withNewspaper(async root => {
  const before = '2026-09-29';
  const earlier = await pageGroupIds(root, before);
  assert.doesNotThrow(() => checkEdition(fixture(before), before, { groups: earlier }));
  for (const day of ['2026-09-30', '2026-10-01']) {
    const groups = await pageGroupIds(root, day);
    assert.doesNotThrow(() => checkEdition(fixture(day, groups), day, { groups }));
    assert.throws(() => checkEdition(fixture(day), day, { groups }), 'missing group-3 section');
    const missingRank = fixture(day, groups);
    delete missingRank.activity.groups[2].daily[day];
    assert.throws(() => checkEdition(missingRank, day, { groups }), /Missing group-3 daily ranking/);
    const empty = fixture(day, groups);
    empty.digests[0].pages.find(page => page.id === 'group-3').stories = [];
    assert.equal(checkEdition(empty, day, { groups })['group-3'], 0);
  }
}));

test('validates arbitrary edition dates and allows a genuinely empty section', () => {
  const data = fixture();
  data.digests[0].pages[0].stories = [];
  assert.equal(checkEdition(data, date, { groups: twoGroups })['group-1'], 0);
  assert.throws(() => checkEdition(data, '2026-02-30', { groups: twoGroups }));
  assert.throws(() => checkEdition(data, '2026-09-27', { groups: twoGroups }));
  assert.throws(() => checkEdition(data, date, { groups: [] }));
});

test('rejects stale ranks, missing daily ranks, incomplete reviews and draft payloads', () => {
  for (const mutate of [
    d => { d.activity.windows.month.through = '2026-09-30'; },
    d => { delete d.activity.groups[1].daily[date]; },
    d => { d.digests[0].pages[0].stories[0].aiComment = ''; },
    d => { d.digests[0].pages.pop(); },
    d => { d.publicBuild = false; },
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(() => checkEdition(data, date, { groups: twoGroups }));
  }
});

test('historical publication must explicitly preserve newer community cutoff', () => {
  const data = fixture();
  for (const window of Object.values(data.activity.windows)) window.through = '2026-10-02';
  assert.throws(() => checkEdition(data, date, { groups: twoGroups }));
  assert.doesNotThrow(() => checkEdition(data, date, { groups: twoGroups, rankThrough: '2026-10-02' }));
  assert.throws(() => checkEdition(data, date, { groups: twoGroups, rankThrough: '2026-09-30' }));
});
