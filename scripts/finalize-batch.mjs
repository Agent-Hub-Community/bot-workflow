import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rootDir } from '../lib/newspaper-root.mjs';
import { buildCandidate, approveCandidate, validateReview, validateReaderIssues } from '../lib/finalize-batch.mjs';

const args = process.argv.slice(2);
const mode = ['candidate', 'review', 'finalize'].includes(args[0]) ? args.shift() : 'finalize';
const { values, positionals } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    directory: { type: 'string' }, attachments: { type: 'string' }, out: { type: 'string' },
    candidate: { type: 'string' }, review: { type: 'string' }, reviewer: { type: 'string' },
    approve: { type: 'boolean' },
  },
});

const directory = values.directory ? path.resolve(values.directory) : positionals[0] ? path.resolve(positionals[0]) : null;
const output = values.out ? path.resolve(values.out) : directory ? path.join(directory, 'final') : null;
assert.ok(output, 'Usage: finalize-batch.mjs [DIRECTORY] [--directory BATCH] [--attachments MANIFEST] [--out PATH]');

const parent = await realpath(path.dirname(output));
const data = path.join(await realpath(rootDir), 'data');
const destination = path.join(parent, path.basename(output));
assert.ok(destination !== data && !destination.startsWith(data + path.sep) && !data.startsWith(destination + path.sep),
  'Output must not be newspaper/data or its parent');

const json = file => readFile(file, 'utf8').then(JSON.parse);
const saveJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};

async function loadCandidate() {
  assert.ok(directory, 'Provide batch directory');
  const issues = await json(path.join(directory, 'issues.json'));
  const attachmentsFile = values.attachments ? path.resolve(values.attachments) : null;
  if (!attachmentsFile) {
    validateReaderIssues(issues);
    return { version: 1, status: 'pending', snapshot: { issues } };
  }
  const sources = [];
  for (const issue of issues) {
    for (const page of issue.pages) {
      const draftPath = path.join(directory, issue.date, `${page.id}.draft.json`);
      const draft = await json(draftPath).catch(() => null);
      if (draft) sources.push({ date: issue.date, group: page.id, draft });
    }
  }
  return buildCandidate(issues, sources, await json(attachmentsFile));
}

if (mode === 'candidate') {
  await saveJson(destination, await loadCandidate());
  console.log(`Pending candidate: ${destination}`);
} else if (mode === 'review') {
  assert.ok(values.candidate, 'Use --candidate FILE');
  const pending = await json(values.candidate);
  await saveJson(destination, approveCandidate(pending, values.reviewer || 'editor'));
  console.log(`Review recorded: ${destination}`);
} else {
  const pending = await loadCandidate();
  const receipt = values.review ? await json(values.review).catch(() => null) : approveCandidate(pending, values.reviewer || 'editor');
  const issues = validateReview(pending, receipt);
  if (destination.endsWith('.json')) {
    await saveJson(destination, issues);
  } else {
    await saveJson(path.join(destination, 'issues.json'), issues);
    if (receipt) await saveJson(path.join(destination, 'receipt.json'), receipt);
  }
  if (directory && values.attachments) {
    await saveJson(path.join(directory, 'issues.json'), issues);
  }
  console.log(`Finalized group batch: ${destination}`);
}
