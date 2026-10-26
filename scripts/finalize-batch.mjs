import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rename, rm, lstat, realpath, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rootDir, load } from '../lib/newspaper-root.mjs';
const { isGroupId } = await load('lib/groups.mjs');
import { buildCandidate, approveCandidate, validateReview } from '../lib/finalize-batch.mjs';

const [mode, ...args] = process.argv.slice(2);
const { values } = parseArgs({ args, options: {
  directory: { type: 'string' }, attachments: { type: 'string' }, out: { type: 'string' },
  candidate: { type: 'string' }, review: { type: 'string' }, reviewer: { type: 'string' },
  approve: { type: 'boolean' },
} });
assert.ok(['candidate', 'review', 'finalize'].includes(mode) && values.out,
  'Usage: finalize-batch.mjs candidate|review|finalize --out PATH (see docs/finalize.md)');
const allowed = mode === 'review' ? ['candidate', 'reviewer', 'approve', 'out']
  : ['directory', 'attachments', 'out', ...(mode === 'finalize' ? ['review'] : [])];
assert.ok(Object.keys(values).every(name => allowed.includes(name)), 'Unexpected option for this mode');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const output = path.resolve(values.out);
// Resolve the existing parent, so a symlink cannot redirect output into production data.
const parent = await realpath(path.dirname(output));
const data = path.join(await realpath(rootDir), 'data');
const destination = path.join(parent, path.basename(output));
assert.ok(destination !== data && !destination.startsWith(data + path.sep) && !data.startsWith(destination + path.sep),
  'Output must not be newspaper/data or its parent');
for (const name of ['dist', 'dist-preview']) {
  const built = path.join(await realpath(rootDir), name);
  assert.ok(destination !== built && !destination.startsWith(built + path.sep), 'Keep private review files outside static build output');
}
async function existing(file) {
  try {
    const stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), 'Refuse a symlink output');
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function saveJson(value) {
  if (await existing(destination)) {
    assert.deepEqual(await json(destination), value, 'Output already exists with different contents; use a new output path');
    return;
  }
  const temporary = await mkdtemp(path.join(parent, '.finalize-'));
  try {
    const file = path.join(temporary, 'result.json');
    await writeFile(file, bytes(value), { mode: 0o600 });
    await link(file, destination); // Atomic creation without overwriting another writer's output.
    await unlink(file);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function candidate() {
  assert.ok(values.directory && values.attachments, 'Use --directory BATCH and --attachments MANIFEST');
  const directory = path.resolve(values.directory);
  const issues = await json(path.join(directory, 'issues.json'));
  const sources = [];
  for (const issue of issues) for (const page of issue.pages) {
    assert.match(issue.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(page.id, /^group-\d+$/);
    assert.ok(isGroupId(page.id), 'Unknown reader group');
    sources.push({ date: issue.date, group: page.id,
      input: await json(path.join(directory, issue.date, `${page.id}.input.json`)),
      draft: await json(path.join(directory, issue.date, `${page.id}.draft.json`)),
    });
  }
  return buildCandidate(issues, sources, await json(values.attachments));
}
if (mode === 'candidate') {
  await saveJson(await candidate());
  console.log(`Pending candidate: ${destination}`);
} else if (mode === 'review') {
  assert.ok(values.candidate && values.reviewer?.trim() && values.approve,
    'After inspecting the complete candidate: --candidate FILE --reviewer NAME --approve --out RECEIPT');
  const pending = await json(values.candidate);
  if (await existing(destination)) {
    const previous = await json(destination);
    validateReview(pending, previous);
    assert.equal(previous.reviewer, values.reviewer, 'Different reviewer; use a new receipt path');
  } else await saveJson(approveCandidate(pending, values.reviewer));
  console.log(`Review recorded: ${destination}. This is not publication authorization.`);
} else {
  assert.ok(values.review, 'Use --review RECEIPT from the reviewer');
  const pending = await candidate();
  const receipt = await json(values.review);
  const issues = validateReview(pending, receipt);
  if (await existing(destination)) {
    // Downstream activity and preview files may be added without changing the reviewed pair.
    for (const file of ['issues.json', 'receipt.json']) {
      assert.ok(await existing(path.join(destination, file)), 'Missing final output');
    }
    assert.deepEqual(await json(path.join(destination, 'issues.json')), issues, 'Final output changed');
    assert.deepEqual(await json(path.join(destination, 'receipt.json')), receipt, 'Final receipt changed');
  } else {
    const temporary = await mkdtemp(path.join(parent, '.finalize-'));
    try {
      await writeFile(path.join(temporary, 'issues.json'), bytes(issues), { mode: 0o600 });
      await writeFile(path.join(temporary, 'receipt.json'), bytes(receipt), { mode: 0o600 });
      await rename(temporary, destination);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  console.log(`Finalized reviewed group batch: ${destination}. Publication still requires explicit maintainer authorization.`);
}
