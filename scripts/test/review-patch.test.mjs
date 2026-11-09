import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyDailyPatch, applyDailyPatches, applyPageOps, excerpt, weeklyReaderPage } from '../../lib/review-patch.mjs';
import { load } from '../../lib/newspaper-root.mjs';
const { weeklyGroups } = await load('lib/groups.mjs');

const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url));
const dayBatch = path.join(fixtures, 'day-2026-11-01');
const applyCli = fileURLToPath(new URL('../apply-review.mjs', import.meta.url));
const assembleCli = fileURLToPath(new URL('../assemble-weekly-reader.mjs', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-patch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// The 2026-11-01 review, once a hand-written script, expressed as a patch over anonymised source messages.
test('patch reproduces the 2026-11-01 editorial review', async () => {
  const before = await json(path.join(dayBatch, 'issues.pre-review.json'));
  const patch = await json(path.join(fixtures, 'patch-2026-11-01.json'));
  const { issues, warnings } = applyDailyPatch(before, patch, { batchDir: dayBatch });
  assert.deepEqual(issues, await json(path.join(dayBatch, 'issues.expected.json')));
  assert.deepEqual(warnings, []);
  assert.equal(before[0].pages[3].stories.length, 3, 'input issues stay unchanged');
});

test('apply-review keeps the generated issues and reruns from them', async t => {
  const batch = await tempDir(t);
  await cp(path.join(dayBatch, '2026-11-01'), path.join(batch, '2026-11-01'), { recursive: true });
  await cp(path.join(dayBatch, 'issues.pre-review.json'), path.join(batch, 'issues.json'));
  const patch = path.join(fixtures, 'patch-2026-11-01.json');
  const expected = await json(path.join(dayBatch, 'issues.expected.json'));
  const { stdout } = await exec(process.execPath, [applyCli, batch, patch]);
  assert.match(stdout, /group-4:4/);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), expected);
  assert.deepEqual(await json(path.join(batch, 'issues.pre-review.json')),
    await json(path.join(dayBatch, 'issues.pre-review.json')));
  // A second run must not stack edits: the patch's indexes and finds refer to the generated issues.
  await exec(process.execPath, [applyCli, batch, patch]);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), expected);
  const out = path.join(batch, 'preview.json');
  await exec(process.execPath, [applyCli, batch, patch, '--out', out]);
  assert.deepEqual(await json(out), expected);
});

// Splits the 2026-11-01 patch into one patch per group, as separate editors would write them.
async function splitPatch(dir) {
  const patch = await json(path.join(fixtures, 'patch-2026-11-01.json'));
  const files = [];
  for (const [group, edit] of Object.entries(patch.pages)) {
    const file = path.join(dir, `${group}.patch.json`);
    await writeFile(file, JSON.stringify({ pages: { [group]: edit } }));
    files.push(file);
  }
  return files;
}

async function dayCopy(t) {
  const batch = await tempDir(t);
  await cp(path.join(dayBatch, '2026-11-01'), path.join(batch, '2026-11-01'), { recursive: true });
  await cp(path.join(dayBatch, 'issues.pre-review.json'), path.join(batch, 'issues.json'));
  return batch;
}

test('apply-review merges per-group patches so one editor does not undo another', async t => {
  const batch = await dayCopy(t);
  const files = await splitPatch(batch);
  const expected = await json(path.join(dayBatch, 'issues.expected.json'));
  await exec(process.execPath, [applyCli, batch, ...files]);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), expected);
  // Rerunning the same set is idempotent.
  await exec(process.execPath, [applyCli, batch, ...files]);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), expected);
  // Two patches touching the same story of one group conflict.
  const clash = path.join(batch, 'clash.json');
  await writeFile(clash, JSON.stringify({ pages: { 'group-5': { stories: [{ index: 0, title: 'Other' }] } } }));
  await assert.rejects(exec(process.execPath, [applyCli, batch, ...files, clash]),
    /group-5: story 0 edited by both group-5\.patch\.json and clash\.json/);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), expected, 'a rejected run writes nothing');
});

test('apply-review refuses a stale pre-review copy unless rebased', async t => {
  const batch = await dayCopy(t);
  const patch = path.join(fixtures, 'patch-2026-11-01.json');
  const expected = await json(path.join(dayBatch, 'issues.expected.json'));
  await exec(process.execPath, [applyCli, batch, patch]);
  const state = await json(path.join(batch, 'issues.review-state.json'));
  assert.match(state.sha256, /^[0-9a-f]{64}$/);
  // Another step regenerates issues.json: the old pre-review copy no longer describes it.
  const regenerated = await json(path.join(dayBatch, 'issues.pre-review.json'));
  regenerated[0].pages[3].heading = 'Regenerated heading';
  await writeFile(path.join(batch, 'issues.json'), JSON.stringify(regenerated, null, 2) + '\n');
  await assert.rejects(exec(process.execPath, [applyCli, batch, patch]), error => {
    assert.match(error.stderr, /changed since apply-review last wrote it/);
    assert.match(error.stderr, /--rebase/);
    assert.match(error.stderr, /issues\.review-state\.json/);
    return true;
  });
  assert.equal((await json(path.join(batch, 'issues.json')))[0].pages[3].heading, 'Regenerated heading');
  // --rebase makes the regenerated issues the new base, and later plain reruns stay idempotent.
  await exec(process.execPath, [applyCli, batch, patch, '--rebase']);
  assert.deepEqual(await json(path.join(batch, 'issues.pre-review.json')), regenerated);
  const rebased = await json(path.join(batch, 'issues.json'));
  assert.equal(rebased[0].pages[3].heading, 'Regenerated heading');
  assert.deepEqual({ ...rebased[0], pages: rebased[0].pages.map(p => p.stories) },
    { ...expected[0], pages: expected[0].pages.map(p => p.stories) });
  await exec(process.execPath, [applyCli, batch, patch]);
  assert.deepEqual(await json(path.join(batch, 'issues.json')), rebased);
});

test('applyDailyPatches merges by date and rejects page-field conflicts', async t => {
  const { batch, issues } = await syntheticBatch(t, [['Ann', 'hello']]);
  const { issues: [issue] } = applyDailyPatches(issues, [
    { name: 'a', patch: { pages: { 'group-1': { heading: 'A', stories: [{ index: 0, title: 'One' }] } } } },
    { name: 'b', patch: { date: '2026-10-20', pages: { 'group-1': { stories: [{ index: 1, remove: true }] } } } },
  ], { batchDir: batch });
  assert.equal(issue.pages[0].heading, 'A');
  assert.deepEqual(issue.pages[0].stories.map(s => s.title), ['One', 'Third']);
  assert.throws(() => applyDailyPatches(issues, [
    { name: 'a', patch: { pages: { 'group-1': { heading: 'A' } } } },
    { name: 'b', patch: { pages: { 'group-1': { heading: 'B' } } } },
  ], { batchDir: batch }), /group-1: heading edited by both a and b/);
});

async function syntheticBatch(t, messages) {
  const batch = await tempDir(t);
  const date = '2026-10-20';
  await mkdir(path.join(batch, date));
  const input = messages.map(([sender, content, type = '文本'], i) => ({
    id: `m${String(i + 1).padStart(4, '0')}`, time: `${date} 10:${String(i).padStart(2, '0')}`,
    speaker: sender ? `p${sender.length}` : null, type, content,
  }));
  await writeFile(path.join(batch, date, 'group-1.input.json'), JSON.stringify({ messages: input }));
  await writeFile(path.join(batch, date, 'group-1.raw.json'), JSON.stringify(messages.map(([sender]) => ({ sender }))));
  const issues = [{ id: date, date, label: 'Synthetic', pages: [{ id: 'group-1', label: '一群', section: 'A',
    heading: 'H', theme: 'T', note: 'N', stories: [
      { category: 'C', title: 'First', text: 'The local queue drains twice a day. The local queue is small.',
        emphasis: ['drains twice a day'], aiComment: 'One.' },
      { category: 'C', title: 'Second', text: 'A cache warms on start.', emphasis: ['warms on start'], aiComment: 'Two.' },
      { category: 'C', title: 'Third', text: 'An index is rebuilt nightly.', emphasis: [], aiComment: 'Three.' },
    ] }] }];
  return { batch, day: path.join(batch, date), issues };
}

test('excerpt numbers members, keeps two chant copies and resolves quotes', async t => {
  const { day } = await syntheticBatch(t, [
    ['Ann', 'queue drains at noon'],
    [null, '[系统] Bob joined'],
    ['Bob', '[表情]'],
    ['Bob', 'img', '图片'],
    ['Bob', '[引用] really?\n  ↳ Ann: queue drains at noon'],
    ['Cat', '[引用] \n  ↳ Nick B: really?'],
    ['Cat', '[引用] what\n  ↳ Dan: never said here'],
    ['Cat', '[引用] ok\n  ↳ Ann: [成员]: [媒体引用未解析]'],
    ['Ann', '+1'], ['Bob', '+1'], ['Cat', '+1'],
    ['Dan', 'dropped'],
  ]);
  assert.deepEqual(excerpt(day, 'group-1', 'm0001', 'm0012', ['m0012']), [
    { speaker: 1, time: '10:00', text: 'queue drains at noon' },
    { speaker: 2, time: '10:03', text: '[图片]' },
    { speaker: 2, time: '10:04', text: 'really?', quote: { speaker: 1, text: 'queue drains at noon' } },
    // The header nickname is not a sender name, so the quoted text identifies the member.
    { speaker: 3, time: '10:05', text: '[引用]', quote: { speaker: 2, text: 'really?' } },
    { speaker: 3, time: '10:06', text: 'what', quote: { speaker: null, text: 'never said here' } },
    { speaker: 3, time: '10:07', text: 'ok', quote: { speaker: 1, text: '[图片]' } },
    { speaker: 1, time: '10:08', text: '+1' },
    { speaker: 2, time: '10:09', text: '+1' },
  ]);
  assert.throws(() => excerpt(day, 'group-1', 'm0005', 'm0002'), /invalid message range/);
  assert.throws(() => excerpt(day, 'group-1', 'm0002', 'm0005', ['m0003', 'm0001', 'm0099']),
    /drop ids outside m0002\.\.m0005: m0001, m0099/);
});

test('patch edits by original index, replaces unique text and trims emphasis', async t => {
  const { batch, issues } = await syntheticBatch(t, [['Ann', 'hello'], ['Bob', 'world']]);
  const { issues: [issue], warnings } = applyDailyPatch(issues, { pages: { 'group-1': { heading: 'New', stories: [
    { index: 0, remove: true },
    { new: true, category: 'C', title: 'Added', text: 'A new note about queues and how they drain overnight.', emphasis: ['new note', 'missing'],
      aiComment: 'Four.', discussion: { first: 'm0001', last: 'm0002' },
      resources: [{ kind: 'code', label: 'Repo', url: 'https://example.org/repo' }] },
    { index: 2, title: 'Third, retitled' },
    { index: 1, replace: [{ field: 'text', find: 'warms on start', replace: 'is cold' }] },
  ] } } }, { batchDir: batch });
  assert.equal(issue.pages[0].heading, 'New');
  assert.deepEqual(issue.pages[0].stories.map(s => s.title), ['Second', 'Third, retitled', 'Added']);
  assert.equal(issue.pages[0].stories[0].text, 'A cache is cold.');
  assert.deepEqual(issue.pages[0].stories[0].emphasis, []);
  assert.deepEqual(issue.pages[0].stories[2].discussion, [
    { speaker: 1, time: '10:00', text: 'hello' }, { speaker: 2, time: '10:01', text: 'world' }]);
  assert.deepEqual(warnings, [
    'group-1 new "Added": emphasis dropped (not-in-text): missing',
    'group-1[1]: emphasis dropped (not-in-text): warms on start',
  ]);
});

test('patch rejects ambiguous finds, listing every one, and non-HTTPS resources', async t => {
  const { batch, issues } = await syntheticBatch(t, []);
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [
    { index: 0, replace: [{ field: 'text', find: 'The local queue', replace: 'A queue' }] },
    { index: 1, replace: [{ field: 'title', find: 'absent', replace: 'x' }] },
  ] } } }, { batchDir: batch }), error => {
    assert.match(error.message, /group-1\[0\]\.text: find occurs 2 times: The local queue/);
    assert.match(error.message, /group-1\[1\]\.title: find occurs 0 times: absent/);
    return true;
  });
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [
    { index: 0, resources: [{ kind: 'paper', label: 'P', url: 'http://example.org/p' }] },
  ] } } }, { batchDir: batch }), /invalid resource/);
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [{ index: 3, title: 'x' }] } } },
    { batchDir: batch }), /no story at index 3/);
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [{ index: 0, titel: 'x' }] } } },
    { batchDir: batch }), /unknown story field titel/);
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [{ index: 0, remove: true, title: 'x' }] } } },
    { batchDir: batch }), /group-1\[0\]: remove cannot be combined with title/);
});

const weeklyPage = () => ({ title: 'Week', intro: 'The week in one line.', stories: [
  { title: 'Queue', text: 'The queue drained twice this week, two members said. The queue was rebuilt on Friday after an outage.', review: 'Fine.',
    emphasis: ['drained twice', 'rebuilt on Friday', 'absent'], dates: ['2026-10-31', '2026-10-27', '2026-10-25'],
    kind: 'new', timeline: [{ date: '2026-10-27', text: 'ignored' }], resources: [], sourceIndex: 3 },
  { title: 'Cache', text: 'The cache warmed slowly.', review: 'Ok.', emphasis: [], dates: ['2026-10-28'],
    kind: 'continuation', timeline: [{ date: '2026-10-28', text: 'Warm start measured.' }],
    resources: [{ kind: 'post', label: 'Post', url: 'https://example.org/post' }] },
] });

test('weekly ops apply only where the quote is unique', () => {
  const { page, manual } = applyPageOps(weeklyPage(), [
    { storyTitle: 'Cache', field: 'text', find: 'slowly', replace: 'quickly' },
    { index: 1, field: 'timeline', find: 'measured', replace: 'timed' },
    { field: 'intro', find: 'one line', replace: 'two lines' },
    { storyTitle: 'Queue', field: 'text', find: 'The queue', replace: 'A queue' },
    { storyTitle: 'Missing', field: 'text', find: 'x', replace: 'y' },
  ]);
  assert.equal(page.stories[1].text, 'The cache warmed quickly.');
  assert.equal(page.stories[1].timeline[0].text, 'Warm start timed.');
  assert.equal(page.intro, 'The week in two lines.');
  assert.deepEqual(manual.map(m => m.reason), ['find occurs 2 times', 'target not found']);
});

test('weekly ops find stories by their original title and flag duplicate titles', () => {
  const input = weeklyPage();
  input.stories.push({ ...input.stories[1], text: 'Another cache story.' });
  const { page, manual } = applyPageOps(input, [
    { storyTitle: 'Queue', field: 'title', find: 'Queue', replace: 'Backlog' },
    // Still the first story: titles resolve against the page before any op ran.
    { storyTitle: 'Queue', field: 'review', find: 'Fine', replace: 'Good' },
    { storyTitle: 'Cache', field: 'text', find: 'cache', replace: 'store' },
  ]);
  assert.equal(page.stories[0].title, 'Backlog');
  assert.equal(page.stories[0].review, 'Good.');
  assert.deepEqual(page.stories.slice(1).map(s => s.text), ['The cache warmed slowly.', 'Another cache story.']);
  assert.deepEqual(manual, [{ storyTitle: 'Cache', field: 'text', find: 'cache', replace: 'store',
    reason: 'storyTitle is ambiguous: 2 stories have this title' }]);
});

test('weekly reader page keeps reader fields, dates in range and continuation timelines', () => {
  const { page, warnings } = weeklyReaderPage({ id: 'group-1', label: '一群' }, weeklyPage(),
    { from: '2026-10-26', through: '2026-11-01' });
  assert.deepEqual(page.stories[0], { title: 'Queue', text: weeklyPage().stories[0].text, review: 'Fine.',
    emphasis: ['drained twice', 'rebuilt on Friday'], dates: ['2026-10-27', '2026-10-31'], kind: 'new',
    timeline: [], resources: [] });
  assert.deepEqual(page.stories[1].timeline, [{ date: '2026-10-28', text: 'Warm start measured.' }]);
  assert.equal(warnings.length, 2);
});

test('assemble-weekly-reader writes reader.json and lists unresolved ops', async t => {
  const batch = await tempDir(t);
  const [from, through] = ['2026-10-26', '2026-11-01'];
  await mkdir(path.join(batch, 'review'));
  for (const group of weeklyGroups(through)) {
    await writeFile(path.join(batch, 'review', `${group.id}.page.json`), JSON.stringify(weeklyPage()));
  }
  await writeFile(path.join(batch, 'review', 'group-2.ops.json'), JSON.stringify([
    { storyTitle: 'Cache', field: 'text', find: 'slowly', replace: 'quickly' },
    { storyTitle: 'Queue', field: 'text', find: 'The queue', replace: 'A queue' },
  ]));
  await writeFile(path.join(batch, 'rank.json'), JSON.stringify({ people: [] }));
  const external = { id: 'external', label: '外部资讯', title: 'News', intro: 'i', stories: [] };
  await writeFile(path.join(batch, 'external-page.json'), JSON.stringify(external));
  const { stdout } = await exec(process.execPath, [assembleCli, batch, '--from', from, '--through', through]);
  assert.match(stdout, /1 review ops need manual edits/);
  const reader = await json(path.join(batch, 'reader', 'reader.json'));
  assert.deepEqual({ ...reader, pages: undefined }, { id: `${from}_${through}`, from, through,
    label: '2026.10.26–11.01 周报', title: 'AgentHub 2026.10.26–11.01 周报', pages: undefined, rank: { people: [] } });
  assert.deepEqual(reader.pages.map(p => p.id), [...weeklyGroups(through).map(g => g.id), 'external']);
  assert.equal(reader.pages[1].stories[1].text, 'The cache warmed quickly.');
  assert.deepEqual((await json(path.join(batch, 'review', 'manual.json'))).map(m => [m.group, m.storyTitle]),
    [['group-2', 'Queue']]);
  await rm(path.join(batch, 'review', 'group-3.page.json'));
  await assert.rejects(exec(process.execPath, [assembleCli, batch, '--from', from, '--through', through]),
    /Missing review pages: group-3\.page\.json/);
  assert.ok(existsSync(path.join(batch, 'reader', 'reader.json')));
});


test('a topical page whose last story is removed is left out, a main page stays', () => {
  const story = title => ({ category: 'c', title, text: `${title} 正文`, emphasis: [], aiComment: 'a' });
  const issues = [{ id: '2026-11-09', date: '2026-11-09', label: 'x', pages: [
    { id: 'group-1', label: '一群', stories: [story('一')] },
    { id: 'group-7', label: 'Robot', stories: [story('七')] },
    { id: 'group-8', label: 'AI4S', stories: [story('八')] },
  ] }];
  const { issues: [issue], warnings } = applyDailyPatch(issues, { pages: {
    'group-1': { stories: [{ index: 0, remove: true }] },
    'group-7': { stories: [{ index: 0, remove: true }] },
  } }, { batchDir: tmpdir() });
  assert.deepEqual(issue.pages.map(page => [page.id, page.stories.length]), [['group-1', 0], ['group-8', 1]]);
  assert.ok(warnings.some(w => /group-7: every story removed/.test(w)));
});

test('daily resources with a query string are rejected when the patch is applied', () => {
  const issues = [{ id: '2026-11-09', date: '2026-11-09', label: 'x', pages: [
    { id: 'group-1', label: '一群', stories: [{ category: 'c', title: 't', text: '正文', emphasis: [], aiComment: 'a' }] }] }];
  assert.throws(() => applyDailyPatch(issues, { pages: { 'group-1': { stories: [{ index: 0,
    resources: [{ kind: 'article', label: 'x', url: 'https://mp.weixin.qq.com/s?__biz=abc&mid=1' }] }] } } },
  { batchDir: tmpdir() }), /must not carry a query string/);
});
