import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPlan, formatCounts, missingEnv, nextRun, prepare, resolveDirs, runPlan, selectSteps }
  from '../daily.mjs';
import { load } from '../../lib/newspaper-root.mjs';

const date = '2026-11-01';
const plan = buildPlan({ date, batch: '/tmp/b', external: '/tmp/e', bot: '/bot' });
const names = steps => steps.map(step => step.name);
const mainOrder = ['collect-batch', 'collect-images', 'generate', 'package', 'enrich', 'release-activity'];
const fullEnv = { WX_ACTIVITY_HOME: '/h', DAILY_LLM_BASE_URL: 'http://x', DAILY_LLM_MODEL: 'm', DAILY_LLM_API_KEY: 'k' };

test('plan runs the chat steps in order and keeps external collection separate', () => {
  assert.deepEqual(names(plan.main), mainOrder);
  assert.equal(plan.external.name, 'collect-external');
  const byName = Object.fromEntries(plan.main.map(step => [step.name, step]));
  assert.deepEqual(byName['collect-batch'].args, ['/bot/pipeline/collect-batch.mjs', date, date, '/tmp/b']);
  // A rerun of generate keeps the drafts that already pass validation.
  assert.deepEqual(byName.generate.args.slice(1), ['generate', date, date, '/tmp/b', '--emphasis', '--resume']);
  assert.deepEqual(byName.package.args.slice(1), ['package', date, date, '/tmp/b', '--emphasis']);
  assert.deepEqual(plan.external.args, ['/bot/scripts/collect-external.mjs', date, '/tmp/e']);
});

test('chat steps never overlap each other; collect-external overlaps them', async () => {
  const active = new Set(), overlaps = [], releases = new Map();
  const run = runPlan(plan, async step => {
    for (const other of active) overlaps.push([other, step.name]);
    active.add(step.name);
    await new Promise(resolve => releases.set(step.name, resolve));
    active.delete(step.name);
  });
  await new Promise(setImmediate);
  assert.deepEqual([...releases.keys()].sort(), ['collect-batch', 'collect-external']);
  for (const name of ['collect-batch', 'collect-external', ...mainOrder.slice(1)]) {
    await new Promise(setImmediate);
    releases.get(name)();
  }
  const result = await run;
  assert.deepEqual(result.done, mainOrder);
  assert.equal(result.failed, null);
  assert.equal(result.resume, null);
  assert.ok(overlaps.length > 0);
  assert.ok(overlaps.every(pair => pair.includes('collect-external')), JSON.stringify(overlaps));
});

test('a failed chat step stops the chat steps and becomes the resume point', async () => {
  const started = [];
  const result = await runPlan(plan, async step => {
    started.push(step.name);
    if (step.name === 'generate') throw new Error('exit 1');
  });
  assert.equal(result.failed.name, 'generate');
  assert.ok(!started.includes('package'));
  assert.equal(result.resume, 'generate');
  assert.equal(result.externalFailed, null);
});

test('a collect-external failure does not stop the chat steps', async () => {
  const result = await runPlan(plan, async step => {
    if (step.name === 'collect-external') throw new Error('exit 1');
  });
  assert.deepEqual(result.done, mainOrder);
  assert.equal(result.failed, null);
  assert.equal(result.resume, null);
  assert.match(result.externalFailed.error.message, /exit 1/);
});

test('--from-step resumes the chat steps from the earliest named one; collect-external only when named', () => {
  assert.deepEqual(names(selectSteps(plan, ['enrich']).main), ['enrich', 'release-activity']);
  assert.equal(selectSteps(plan, ['enrich']).external, null);
  assert.deepEqual(names(selectSteps(plan, ['package', 'collect-images']).main), mainOrder.slice(1));
  const externalOnly = selectSteps(plan, ['collect-external']);
  assert.deepEqual(externalOnly.main, []);
  assert.equal(externalOnly.external.name, 'collect-external');
  assert.equal(selectSteps(plan, []), plan);
  assert.throws(() => selectSteps(plan, ['publish']), /Unknown step publish/);
});

test('default directories take the first run number free for both batch and external', () => {
  assert.equal(nextRun([], date), 1);
  assert.equal(nextRun([`day-${date}-run1`, `day-${date}-run2`, `day-2026-10-31-run3`], date), 3);
  assert.equal(nextRun([`external-${date}-run1`], date), 2);
  const scratch = '/news/scratch';
  assert.deepEqual(resolveDirs({ date, scratch, entries: [`day-${date}-run1`] }),
    { batch: path.join(scratch, `day-${date}-run2`), external: path.join(scratch, `external-${date}-run2`) });
  assert.deepEqual(resolveDirs({ date, scratch, entries: [], batch: '/x/b' }),
    { batch: '/x/b', external: path.join(scratch, `external-${date}-run1`) });
  assert.throws(() => resolveDirs({ date, scratch, entries: [], fromSteps: ['generate'] }), /--batch/);
});

test('required environment depends on the selected steps', () => {
  assert.deepEqual(missingEnv(plan, fullEnv), []);
  assert.deepEqual(missingEnv(plan, { ...fullEnv, DAILY_LLM_MODEL: '' }), ['DAILY_LLM_MODEL']);
  assert.deepEqual(missingEnv(selectSteps(plan, ['collect-external']), {}), []);
  assert.deepEqual(missingEnv(selectSteps(plan, ['package']), { WX_ACTIVITY_HOME: '/h' }),
    ['DAILY_LLM_BASE_URL', 'DAILY_LLM_MODEL', 'DAILY_LLM_API_KEY']);
});

test('group counts flag empty and missing groups', () => {
  const lines = formatCounts([
    { id: 'group-1', label: '一群', count: 0 },
    { id: 'group-2', label: '二群', count: 120 },
    { id: 'group-3', label: '三群', count: null },
  ]);
  assert.match(lines[1], /!! 一群.*0 条/);
  assert.doesNotMatch(lines[2], /!!/);
  assert.match(lines[3], /!! 三群.*没有 raw\.json/);
  assert.match(lines.at(-1), /2 个群/);
  assert.equal(formatCounts([{ id: 'group-1', label: '一群', count: 3 }]).length, 2);
});

// Runs prepare() in a temporary scratch directory with fake steps; `behave(step, batch)` stands in for each script.
async function withScratch(fn) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'daily-runner-'));
  try { return await fn(scratch); } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function fakeRun(scratch, options, behave) {
  const lines = [], ran = [];
  const code = await prepare({ date, fromSteps: [], dryRun: false, ...options }, {
    scratch, env: fullEnv, log: line => lines.push(line),
    run: async (step, logs) => { ran.push(step.name); await behave(step, path.dirname(logs)); },
  });
  return { code, ran, output: lines.join('\n'), lines };
}

const { collectedGroups } = await load('lib/groups.mjs');
const groups = collectedGroups(date);

// collect-batch writes one raw.json per group, the first one empty; release-activity leaves two avatars pending.
async function realisticStep(step, batch) {
  if (step.name === 'collect-batch') {
    await mkdir(path.join(batch, date), { recursive: true });
    for (const [index, { id }] of groups.entries()) {
      await writeFile(path.join(batch, date, `${id}.raw.json`), JSON.stringify(index ? [{}, {}] : []));
    }
  }
  if (step.name === 'release-activity') {
    await mkdir(path.join(batch, 'activity'), { recursive: true });
    await writeFile(path.join(batch, 'activity', 'avatar-review.json'), JSON.stringify({ pending: ['a.png', 'b.png'] }));
  }
}

test('prepare shows the group counts right after collect-batch and again at the end with the avatar check', () =>
  withScratch(async scratch => {
    const { code, ran, lines, output } = await fakeRun(scratch, {}, realisticStep);
    assert.equal(code, 0);
    assert.deepEqual(ran.filter(name => name !== 'collect-external'), mainOrder);
    const countLines = lines.flatMap((line, index) => line.startsWith('各群条数') ? [index] : []);
    assert.equal(countLines.length, 2);
    const batchDone = lines.findIndex(line => line.startsWith('[完成] collect-batch'));
    const imagesStart = lines.indexOf('[开始] collect-images');
    assert.ok(batchDone < countLines[0] && countLines[0] < imagesStart, output);
    assert.match(lines[countLines[0]], new RegExp(`!! ${groups[0].label}.*0 条`));
    assert.ok(countLines[1] > lines.findIndex(line => line.startsWith('[完成] release-activity')));
    assert.match(output, /!! 2 个新头像待人工查看.*activity\/avatar-review\.json 的 pending/);
    assert.doesNotMatch(output, /collect-external 失败/);
  }));

test('prepare finishes the chat steps when collect-external fails and points to a fresh external directory', () =>
  withScratch(async scratch => {
    const { code, ran, output } = await fakeRun(scratch, {}, async (step, batch) => {
      await realisticStep(step, batch);
      if (step.name === 'collect-external') {
        // Like the real script: the snapshot is written, then a failed source makes it exit non-zero.
        const external = step.args.at(-1);
        await mkdir(external, { recursive: true });
        await writeFile(path.join(external, 'discovery.json'), '{}');
        throw new Error('exit 1');
      }
    });
    assert.equal(code, 0);
    assert.ok(ran.includes('release-activity'));
    assert.match(output, /!! collect-external 失败，外部资讯需要补查/);
    assert.match(output, new RegExp(`scripts/collect-external\\.mjs ${date} \\S*external-${date}-run2$`, 'm'));
    assert.doesNotMatch(output, /--from-step/);
  }));

test('a failed chat step prints a resume command for that step only', () =>
  withScratch(async scratch => {
    const { code, ran, output } = await fakeRun(scratch, {}, async (step, batch) => {
      await realisticStep(step, batch);
      if (step.name === 'package') throw new Error('exit 1');
    });
    assert.equal(code, 1);
    assert.ok(!ran.includes('enrich'));
    assert.match(output, /--batch \S*day-2026-11-01-run1 --from-step package$/m);
    assert.doesNotMatch(output, /--external/);
  }));

test('--from-step refuses a batch without the day directory before running anything', () =>
  withScratch(async scratch => {
    const batch = path.join(scratch, 'missing-batch');
    await assert.rejects(fakeRun(scratch, { batch, fromSteps: ['generate'] }, async () => {
      throw new Error('no step may run');
    }), /does not exist/);
    assert.deepEqual(await readdir(scratch), []);
    // With the day directory present the same command resumes at generate.
    await mkdir(path.join(batch, date), { recursive: true });
    const { code, ran } = await fakeRun(scratch, { batch, fromSteps: ['generate'] }, async () => {});
    assert.equal(code, 0);
    assert.deepEqual(ran, mainOrder.slice(2));
  }));
