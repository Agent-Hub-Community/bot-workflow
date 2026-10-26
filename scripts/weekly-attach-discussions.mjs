// Attach anonymous source messages and write their identities to a separate private audit.
// Usage: weekly-attach-discussions.mjs READER_JSON INPUT_DIR EVIDENCE_DIR AUDIT_JSON [--exclusions FILE]
import { readFile, writeFile, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../lib/newspaper-root.mjs';
import { prepareMessages, buildDiscussion, compareRefs } from '../lib/weekly-discussion.mjs';
const { sanitizeInput } = await load('lib/daily-generation.mjs');
const { collectedGroups } = await load('lib/groups.mjs');

const [readerFile, inputDir, evidenceDir, auditFile] = process.argv.slice(2);
if (!readerFile || !inputDir || !evidenceDir || !auditFile || auditFile.startsWith('--')) {
  throw new Error('Usage: weekly-attach-discussions.mjs READER_JSON INPUT_DIR EVIDENCE_DIR AUDIT_JSON [--exclusions FILE]');
}
if (path.resolve(readerFile) === path.resolve(auditFile)) throw new Error('Reader and private audit must use different files');
const reader = JSON.parse(await readFile(readerFile, 'utf8'));
const dates = [];
for (let t = Date.parse(`${reader.from || reader.start}T00:00:00Z`); t <= Date.parse(`${reader.through || reader.end}T00:00:00Z`); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
if (!dates.length || dates.length > 31) throw new Error('Expected a date range of 1-31 days');
const exclusionsFlag = process.argv.indexOf('--exclusions');
if (exclusionsFlag >= 0 && !process.argv[exclusionsFlag + 1]) throw new Error('--exclusions requires a file');
const exclusions = exclusionsFlag < 0 ? {} : JSON.parse(await readFile(process.argv[exclusionsFlag + 1], 'utf8'));
if (!exclusions || Array.isArray(exclusions) || Object.keys(exclusions).some(key => !['exclude', 'removeQuote'].includes(key))) {
  throw new Error('Exclusions must contain only exclude and removeQuote arrays');
}
for (const key of ['exclude', 'removeQuote']) {
  if (exclusions[key] !== undefined && !Array.isArray(exclusions[key])) throw new Error(`Invalid exclusions.${key}`);
  for (const row of exclusions[key] || []) {
    if (!row || typeof row.ref !== 'string' || !reader.pages.some(page => page.id === row.group && /^group-/.test(page.id))) throw new Error('Invalid exclusion group/ref');
    compareRefs(row.ref, row.ref);
  }
}
const byGroup = new Map(), allNames = new Set();
for (const page of reader.pages.filter(p => /^group-/.test(p.id))) {
  const days = [];
  for (const date of dates.filter(date => collectedGroups(date).some(group => group.id === page.id))) {
    const inputFile = path.join(inputDir, date, `${page.id}.input.json`);
    const input = JSON.parse(await readFile(inputFile, 'utf8'));
    // Resolve the input link so its raw companion comes from the same daily source.
    const raw = JSON.parse(await readFile((await realpath(inputFile)).replace(/\.input\.json$/, '.raw.json'), 'utf8'));
    days.push({ date, group: page.id, input, raw });
  }
  const messages = prepareMessages(days, { sanitizeInput });
  for (const row of messages) if (row.rawSender) allNames.add(row.rawSender);
  for (const key of ['exclude', 'removeQuote']) for (const row of exclusions[key] || []) {
    if (row.group === page.id && !messages.some(message => message.ref === row.ref)) throw new Error('Unknown exclusion ref');
  }
  byGroup.set(page.id, messages);
}
const audit = [];
for (const page of reader.pages.filter(p => /^group-/.test(p.id))) {
  const evidenceFile = JSON.parse(await readFile(path.join(evidenceDir, `${page.id}.evidence.json`), 'utf8'));
  if (evidenceFile.group !== page.id || !evidenceFile.evidence || typeof evidenceFile.evidence !== 'object' || Array.isArray(evidenceFile.evidence)) throw new Error('Invalid evidence group/map');
  page.stories.forEach((story, index) => {
    const refs = evidenceFile.evidence[index] || [];
    if (!Array.isArray(refs)) throw new Error('Evidence refs must be an array');
    const result = buildDiscussion(byGroup.get(page.id), refs, { allNames,
      excludedRefs: (exclusions.exclude || []).filter(row => row.group === page.id).map(row => row.ref),
      removeQuoteRefs: (exclusions.removeQuote || []).filter(row => row.group === page.id).map(row => row.ref),
    });
    story.discussion = result.discussion;
    audit.push(...result.audit.map(row => ({ page: page.id, story: index, ...row })));
  });
  const counts = page.stories.map(story => story.discussion.length);
  console.log(JSON.stringify({ page: page.id, stories: counts.length, messages: counts.reduce((a, b) => a + b, 0), max: Math.max(0, ...counts), empty: counts.filter(n => !n).length }));
}
await writeFile(auditFile, JSON.stringify(audit, null, 2) + '\n', { mode: 0o600 });
await chmod(auditFile, 0o600);
await writeFile(readerFile, JSON.stringify(reader, null, 2) + '\n');
