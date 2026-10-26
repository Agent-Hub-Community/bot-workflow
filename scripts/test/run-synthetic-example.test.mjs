import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rootDir, requirePackage } from '../../lib/newspaper-root.mjs';
import { runInNewContext } from 'node:vm';
const { parseHTML } = requirePackage('linkedom');
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../run-synthetic-example.mjs', import.meta.url));
const json = file => readFile(file, 'utf8').then(JSON.parse);
const safeEnv = () => {
  const env = { ...process.env, NEWSPAPER_DIR: rootDir,
    DAILY_LLM_BASE_URL: 'https://must-not-contact.invalid/v1', DAILY_LLM_API_KEY: 'not-a-real-fixture-secret',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', WX_BIN: '/must-not-execute-wx',
  };
  delete env.NODE_OPTIONS;
  return env;
};

test('synthetic runner refuses unmarked and symlink outputs before writing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keep = path.join(directory, 'keep.txt');
  await writeFile(keep, 'user-owned');
  const run = out => exec(process.execPath, [cli, '--out', out], { env: safeEnv(), timeout: 20000 });
  await assert.rejects(run(directory));
  assert.deepEqual(await readdir(directory), ['keep.txt']);
  const linked = path.join(directory, 'linked');
  await symlink(directory, linked);
  await assert.rejects(run(linked), /symlink/);
  assert.equal(await readFile(keep, 'utf8'), 'user-owned');
  await assert.rejects(run(path.join(rootDir, 'synthetic-do-not-create')), /separate/);
});

test('actual offline CLI chain covers full review, cross-day identity, external and rendered files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-chain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = path.join(directory, 'example');
  // prepare-preview owns dist-preview; each test gets a disposable clone instead of racing user previews.
  const newspaper = path.join(directory, 'newspaper');
  await exec('git', ['clone', '--quiet', '--no-hardlinks', rootDir, newspaper], { timeout: 30000 });
  await symlink(path.join(rootDir, 'node_modules'), path.join(newspaper, 'node_modules'), 'dir');
  const production = await exec('git', ['-C', newspaper, 'status', '--porcelain', '--', 'data']);
  const run = () => exec(process.execPath, [cli, '--out', out], { env: { ...safeEnv(), NEWSPAPER_DIR: newspaper }, timeout: 120000, maxBuffer: 4000000 });
  const first = JSON.parse((await run()).stdout);
  assert.equal(first.synthetic, true);
  assert.equal(first.validation.sourceEquality, true);
  assert.equal(first.validation.activityEquality, true);
  assert.equal(first.validation.publicBuild, false);
  assert.equal(first.validation.feedbackDisabled, true);
  const result = await json(path.join(first.runDirectory, 'result.json'));
  for (const expected of ['prepare-week-d.mjs', 'enrich-month-d.mjs', 'weekly-discussion-evidence.mjs',
    'weekly-attach-discussions.mjs', 'weekly-select-discussion.mjs', 'finalize-batch.mjs',
    'generate-external.mjs', 'review-external.mjs', 'prepare-preview.mjs']) {
    assert.ok(result.commands.some(command => command.script === expected), expected);
  }
  assert.ok(result.requests.every(request => request.model === 'synthetic-fixed-response'));
  const final = first.finalDirectory;
  const issues = await json(path.join(final, 'issues.json'));
  assert.equal(issues.length, 2);
  assert.ok(issues.every(issue => issue.pages.length === 5 && issue.pages[4].stories.length === 0));
  assert.ok(issues[0].pages[0].stories[0].resources.length);
  assert.ok(issues[1].pages[0].stories[0].discussion.length);
  assert.equal(issues[1].pages[0].stories[0].discussion.at(-1).quote.speaker, null,
    'A daily excerpt must not claim a previous-day quote speaker is visible');
  const receipt = await json(path.join(final, 'receipt.json'));
  assert.equal(receipt.status, 'approved');
  assert.match(receipt.reviewer, /not human approval/);
  assert.deepEqual(receipt.snapshot.issues, issues);
  const weekly = await json(path.join(first.runDirectory, 'weekly.json'));
  const discussion = weekly.pages[0].stories[0].discussion;
  assert.equal(new Set(discussion.map(entry => entry.speaker)).size, 4);
  assert.equal(discussion.at(-1).quote.speaker, discussion[0].speaker);
  const png = await readFile(path.join(final, 'activity/avatars/member-001.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 32);
  const previewEntries = await readdir(first.previewDirectory);
  assert.equal(previewEntries.length, 1);
  const preview = path.join(first.previewDirectory, previewEntries[0]);
  const html = await readFile(path.join(preview, 'daily/2026-10-21/group-1/index.html'), 'utf8');
  assert.match(html, /合成/);
  assert.equal(await readFile(path.join(preview, 'avatars/member-001.png')).then(buffer => buffer.equals(png)), true);
  assert.ok(!(await readdir(preview)).includes('receipt.json'));
  // Execute the actual reader renderer against a DOM, so hidden/unsupported cards cannot pass as JSON only.
  const { window, document } = parseHTML('<html><body><div id="reading"></div><div id="edition-sections"></div></body></html>');
  window.AgentHubDiscussion = { trigger: () => '', configure() {}, resourceKind: resource => resource.kind };
  window.lucide = { createIcons() {} };
  runInNewContext(await readFile(path.join(preview, 'digest.js'), 'utf8'), { window, document, URL });
  window.renderDigest(issues[0], () => {}, { digests: issues }, 'group-1');
  const card = document.querySelector('.brief-resources a');
  assert.ok(card, 'The real daily renderer must display a resource card');
  assert.equal(card.getAttribute('href'), 'https://example.org/synthetic-notebook');
  assert.match(card.textContent, /合成项目占位地址/);
  const second = JSON.parse((await run()).stdout);
  assert.notEqual(second.runDirectory, first.runDirectory);
  assert.deepEqual(await json(path.join(final, 'receipt.json')), receipt, 'A repeat run must preserve old evidence');
  assert.equal((await exec('git', ['-C', newspaper, 'status', '--porcelain', '--', 'data'])).stdout, production.stdout);
});
