// Applies editors' review patches (format: lib/review-patch.mjs applyDailyPatch) to a daily batch.
// Usage: apply-review.mjs BATCH PATCH_JSON [PATCH_JSON...] [--out FILE] [--rebase]
// Pass every patch of the batch in one run: they are merged (two patches editing the same story of one
// group is an error) and applied together, so one editor's patch never discards another's.
// The first run keeps the generated issues as BATCH/issues.pre-review.json. Every run starts from that
// copy, so an editor can revise a patch and run again without stacking edits or shifting indexes.
// BATCH/issues.review-state.json records the sha256 of the issues.json this script last left behind.
// If issues.json changed since (regenerated, or edited by another step), the copy is stale and the run
// stops; --rebase makes the current issues.json the new pre-review copy.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyDailyPatches } from '../lib/review-patch.mjs';

const { positionals: [batch, ...patchFiles], values: { out, rebase } } = parseArgs({
  allowPositionals: true, options: { out: { type: 'string' }, rebase: { type: 'boolean' } },
});
if (!batch || !patchFiles.length) throw new Error('Usage: apply-review.mjs BATCH PATCH_JSON [PATCH_JSON...] [--out FILE] [--rebase]');
const current = path.join(batch, 'issues.json');
const original = path.join(batch, 'issues.pre-review.json');
const stateFile = path.join(batch, 'issues.review-state.json');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const recordState = text => writeFile(stateFile, JSON.stringify({ sha256: sha256(text) }, null, 2) + '\n');

const currentText = await readFile(current, 'utf8');
if (!existsSync(original) || rebase) {
  await writeFile(original, currentText, { mode: 0o600 });
  await recordState(currentText);
} else {
  const recorded = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, 'utf8')).sha256 : null;
  if (recorded !== sha256(currentText)) {
    throw new Error(`${current} changed since apply-review last wrote it (regenerated or edited by another step), ` +
      `so ${path.basename(original)} may be stale. After checking, either delete ${original} and ${stateFile} ` +
      'and run again, or pass --rebase to use the current issues.json as the new pre-review copy.');
  }
}
const issues = JSON.parse(await readFile(original, 'utf8'));
const patches = await Promise.all(patchFiles.map(async file =>
  ({ name: path.basename(file), patch: JSON.parse(await readFile(file, 'utf8')) })));
const { issues: reviewed, warnings } = applyDailyPatches(issues, patches, { batchDir: batch });
const target = out ?? current;
const text = JSON.stringify(reviewed, null, 2) + '\n';
await writeFile(target, text, { mode: 0o600 });
if (path.resolve(target) === path.resolve(current)) await recordState(text);
for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const issue of reviewed) {
  console.log(`${issue.date} ${issue.pages.map(p => `${p.id}:${p.stories.length}`).join(' ')}`);
}
console.log(`Applied ${patches.map(p => p.name).join(', ')} to issues.pre-review.json -> ${target}`);
