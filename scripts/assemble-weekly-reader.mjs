// Assembles reviewed weekly pages into BATCH/reader/reader.json.
// Usage: assemble-weekly-reader.mjs BATCH --from YYYY-MM-DD --through YYYY-MM-DD
// Reads, for each weekly group, BATCH/review/<group>.page.json (the editor's final page) and, when present,
// BATCH/review/<group>.ops.json ([{storyTitle|index, field, find, replace}] from the second reviewer).
// Ops that do not match exactly one place go to BATCH/review/manual.json for a person to resolve;
// rewrite the page or the op and run again. Then adds BATCH/rank.json and optional BATCH/external-page.json.
// BATCH/rank-review.json (from prepare-weekly-rank.mjs) must have no pending avatars; when it is absent the
// review state of the avatars rank.json uses is unknown and the run only warns.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { load } from '../lib/newspaper-root.mjs';
import { applyPageOps, weeklyReaderPage } from '../lib/review-patch.mjs';
const { weeklyGroups } = await load('lib/groups.mjs');

const { positionals: [batch], values: { from, through } } = parseArgs({
  allowPositionals: true, options: { from: { type: 'string' }, through: { type: 'string' } },
});
const day = /^\d{4}-\d{2}-\d{2}$/;
if (!batch || !day.test(from ?? '') || !day.test(through ?? '') || from > through) {
  throw new Error('Usage: assemble-weekly-reader.mjs BATCH --from YYYY-MM-DD --through YYYY-MM-DD');
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const review = path.join(batch, 'review');
const groups = weeklyGroups(through);
const missing = groups.filter(g => !existsSync(path.join(review, `${g.id}.page.json`))).map(g => g.id);
if (missing.length) throw new Error(`Missing review pages: ${missing.map(id => `${id}.page.json`).join(', ')}`);

const rank = await json(path.join(batch, 'rank.json'));
const rankReview = path.join(batch, 'rank-review.json');
const warnings = [];
if (existsSync(rankReview)) {
  const { pending = [] } = await json(rankReview);
  if (pending.length) {
    throw new Error(`Weekly rank avatars not reviewed: ${pending.join(', ')} still pending in ${rankReview}`);
  }
} else {
  const avatars = (rank.groups ?? []).flatMap(g => (g.leaders ?? []).map(l => l.avatar)).filter(Boolean);
  if (avatars.length) warnings.push(`${rankReview} not found: ${avatars.length} rank.json avatars were not checked for review`);
}

const pages = [], manual = [];
for (const group of groups) {
  let page = await json(path.join(review, `${group.id}.page.json`));
  const opsFile = path.join(review, `${group.id}.ops.json`);
  if (existsSync(opsFile)) {
    const result = applyPageOps(page, await json(opsFile));
    page = result.page;
    manual.push(...result.manual.map(op => ({ group: group.id, ...op })));
  }
  const result = weeklyReaderPage(group, page, { from, through });
  pages.push(result.page);
  warnings.push(...result.warnings);
}
const external = path.join(batch, 'external-page.json');
if (existsSync(external)) pages.push(await json(external));
const label = `${from.replaceAll('-', '.')}–${through.slice(5).replaceAll('-', '.')} 周报`;
const issue = { id: `${from}_${through}`, from, through, label, title: `AgentHub ${label}`, pages,
  rank };
await mkdir(path.join(batch, 'reader'), { recursive: true });
await writeFile(path.join(batch, 'reader', 'reader.json'), JSON.stringify(issue, null, 2) + '\n');
// Written on every run so a resolved list does not linger from an earlier run.
await writeFile(path.join(review, 'manual.json'), JSON.stringify(manual, null, 2) + '\n');
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(pages.map(p => `${p.id}:${p.stories.length}`).join(' '));
if (manual.length) console.log(`${manual.length} review ops need manual edits: ${path.join(review, 'manual.json')}`);
