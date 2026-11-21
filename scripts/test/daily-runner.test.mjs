import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCollectPlan, buildFinishPlan, collect, commitSubject, finish, formatCounts,
  missingEnv, nextRun, publish, publishedMessage, resolveDirs, runPlan, selectSteps,
} from '../daily.mjs';

const date = '2026-11-20';
const names = plan => [...plan.main, ...(plan.external ? [plan.external] : [])].map(s => s.name);

test('collect plan runs all three WeChat steps sequentially and external in parallel with zero LLM env vars', () => {
  const plan = buildCollectPlan({ date, batch: '/tmp/b', external: '/tmp/e', bot: '/bot' });
  assert.deepEqual(plan.main.map(s => s.name), ['collect-batch', 'collect-images', 'release-activity']);
  assert.equal(plan.external.name, 'collect-external');
  assert.deepEqual(missingEnv(plan, {}), ['WX_ACTIVITY_HOME']);
  assert.deepEqual(missingEnv(plan, { WX_ACTIVITY_HOME: '/h' }), []);
  assert.deepEqual(selectSteps(plan, ['collect-images']).main.map(s => s.name), ['collect-images', 'release-activity']);
  assert.equal(selectSteps(plan, ['collect-images']).external, null);
  const extPlan = buildCollectPlan({ date, batch: '/tmp/b', external: '/tmp/e', bot: '/bot', throughNow: true });
  assert.ok(extPlan.main[0].args.includes('--through-now'));
  assert.ok(extPlan.external.args.includes('--through-now'));
});

test('nextRun and resolveDirs pair day-D-runN with external-D-runN', () => {
  assert.equal(nextRun(['day-2026-11-20-run1', 'external-2026-11-20-run2'], date), 3);
  const resolved = resolveDirs({ date, batch: '/s/day-2026-11-20-run2', scratch: '/s', entries: [] });
  assert.equal(resolved.external, '/s/external-2026-11-20-run2');
});

test('runPlan stops main on failure while letting external finish', async () => {
  const plan = buildCollectPlan({ date, batch: '/tmp/b', external: '/tmp/e', bot: '/bot' });
  const ran = [];
  const res = await runPlan(plan, async step => {
    ran.push(step.name);
    if (step.name === 'collect-images') throw new Error('decode failed');
  });
  assert.equal(res.resume, 'collect-images');
  assert.deepEqual(res.done, ['collect-batch']);
  assert.ok(ran.includes('collect-external'));
  assert.equal(res.externalFailed, null);
});

test('finish runs package-daily, link-previews and preview with zero review patches or LLM calls', () => {
  const steps = buildFinishPlan({
    date, batch: '/b', external: '/e', bot: '/bot', newspaper: '/np',
    has: f => f === '/e/reviewed-final.json' || f === '/e/selection.json',
  });
  assert.deepEqual(steps.map(s => s.name), ['package-daily', 'link-previews', 'preview']);
  assert.equal(steps[1].optional, true);
  assert.ok(steps[2].args.includes('--external-draft'));
});

test('publishedMessage retitles preview draft and commitSubject formats date', () => {
  const draft = 'AgentHub 2026.11.20 日报导览（链接待上线核验）\nhttps://example.com\n\n【一群】内容';
  assert.match(publishedMessage(draft), /^AgentHub 2026\.11\.20 日报已上线\n/);
  assert.equal(commitSubject(date), 'Publish November 20 daily with external news and rankings');
  assert.ok(formatCounts([{ id: 'group-1', label: '一群', count: 5, images: 2 }]).join('\n').includes('已解图 2 张'));
});

test('collect, finish, and publish dry-run succeed cleanly without external LLM env vars', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthub-daily-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scratch = path.join(dir, 'scratch');
  const batch = path.join(scratch, `day-${date}-run1`);
  await mkdir(batch, { recursive: true });
  await writeFile(path.join(batch, 'issues.json'), '[]');
  assert.equal(await collect({ date, fromSteps: [], dryRun: true }, { scratch, env: { WX_ACTIVITY_HOME: '/h' }, log: () => {} }), 0);
  assert.equal(await finish({ date, batch, dryRun: true }, { log: () => {} }), 0);
  const sh = (cmd, args) => {
    if (args.includes('--show-current')) return 'main';
    if (args.includes('--porcelain')) return '';
    return '';
  };
  assert.equal(await publish({ date, batch, dryRun: true, verify: false }, { sh, log: () => {} }), 0);
});
