// Attach anonymous source messages (and any locally decoded/optimized media) and write identities to a private audit.
// Usage: weekly-attach-discussions.mjs READER_JSON INPUT_DIR EVIDENCE_DIR AUDIT_JSON [--exclusions FILE]
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../lib/newspaper-root.mjs';
import { prepareMessages, buildDiscussion, compareRefs } from '../lib/weekly-discussion.mjs';
const { sanitizeInput } = await load('lib/daily-generation.mjs');
const { collectedGroups } = await load('lib/groups.mjs');
const { validateAttachments } = await load('lib/attachments.mjs');

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
const byGroup = new Map(), allNames = new Set(), mediaByGroupRef = new Map();
for (const page of reader.pages.filter(p => /^group-/.test(p.id))) {
  const days = [];
  const mediaIndex = new Map();
  for (const date of dates.filter(date => collectedGroups(date).some(group => group.id === page.id))) {
    const inputFile = path.join(inputDir, date, `${page.id}.input.json`);
    const input = JSON.parse(await readFile(inputFile, 'utf8'));
    // Resolve the input link so its raw companion and media manifest come from the same daily source.
    const realInput = await realpath(inputFile);
    const raw = JSON.parse(await readFile(realInput.replace(/\.input\.json$/, '.raw.json'), 'utf8'));
    days.push({ date, group: page.id, input, raw });
    const dayDir = path.dirname(realInput);
    const mediaFile = existsSync(path.join(dayDir, `${page.id}.media.json`))
      ? path.join(dayDir, `${page.id}.media.json`)
      : existsSync(path.join(dayDir, `${page.id}.images.json`)) ? path.join(dayDir, `${page.id}.images.json`) : null;
    if (mediaFile) {
      for (const rec of JSON.parse(await readFile(mediaFile, 'utf8'))) {
        if (rec?.id) mediaIndex.set(`${date}:${rec.id}`, { ...rec, dayDir });
      }
    }
  }
  mediaByGroupRef.set(page.id, mediaIndex);
  const messages = prepareMessages(days, { sanitizeInput });
  for (const row of messages) if (row.rawSender) allNames.add(row.rawSender);
  for (const key of ['exclude', 'removeQuote']) for (const row of exclusions[key] || []) {
    if (row.group === page.id && !messages.some(message => message.ref === row.ref)) throw new Error('Unknown exclusion ref');
  }
  byGroup.set(page.id, messages);
}
const batchRoot = path.resolve(inputDir);
async function stageMedia(dayDir, sourceRel, bucket, name) {
  const relative = path.posix.join('attachments', bucket, name);
  const destination = path.join(batchRoot, relative);
  if (!existsSync(destination)) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path.join(dayDir, sourceRel), destination);
  }
  return relative;
}
const audit = [];
for (const page of reader.pages.filter(p => /^group-/.test(p.id))) {
  const evidenceFile = JSON.parse(await readFile(path.join(evidenceDir, `${page.id}.evidence.json`), 'utf8'));
  if (evidenceFile.group !== page.id || !evidenceFile.evidence || typeof evidenceFile.evidence !== 'object' || Array.isArray(evidenceFile.evidence)) throw new Error('Invalid evidence group/map');
  const mediaIndex = mediaByGroupRef.get(page.id) || new Map();
  for (const [index, story] of page.stories.entries()) {
    const refs = evidenceFile.evidence[index] || [];
    if (!Array.isArray(refs)) throw new Error('Evidence refs must be an array');
    const result = buildDiscussion(byGroup.get(page.id), refs, { allNames,
      excludedRefs: (exclusions.exclude || []).filter(row => row.group === page.id).map(row => row.ref),
      removeQuoteRefs: (exclusions.removeQuote || []).filter(row => row.group === page.id).map(row => row.ref),
    });
    for (let i = 0; i < result.discussion.length; i++) {
      const msg = result.discussion[i];
      const rec = mediaIndex.get(result.audit[i]?.ref);
      if (!rec) continue;
      const text = msg.text.trim();
      const kind = rec.kind || (rec.file && text === '[图片]' ? 'image' : null);
      if (kind === 'image' && rec.file) {
        const ext = rec.format || path.extname(rec.file).slice(1) || 'webp';
        const src = await stageMedia(rec.dayDir, rec.file, 'media', `${rec.md5 || result.audit[i].ref.replace(':', '-')}.${ext}`);
        msg.attachments = [{ kind: 'image', src, alt: String(rec.description || '群聊图片').slice(0, 240), ...(rec.width && rec.height ? { width: rec.width, height: rec.height } : {}) }];
      } else if (kind === 'video' && (rec.file || rec.poster)) {
        const posterExt = rec.posterFormat || path.extname(rec.poster || '').slice(1) || 'webp';
        const poster = rec.poster ? await stageMedia(rec.dayDir, rec.poster, 'media', `${rec.posterMd5 || `${result.audit[i].ref.replace(':', '-')}-poster`}.${posterExt}`) : undefined;
        if (rec.file) {
          const src = await stageMedia(rec.dayDir, rec.file, 'media', `${rec.md5 || result.audit[i].ref.replace(':', '-')}.mp4`);
          msg.attachments = [{ kind: 'video', src, mime: 'video/mp4', ...(poster ? { poster } : {}), ...(rec.bytes ? { bytes: rec.bytes } : {}) }];
        } else {
          msg.attachments = [{ kind: 'video', poster, label: '视频' }];
        }
      } else if (kind === 'file' && rec.file) {
        const ext = rec.format || path.extname(rec.file).slice(1);
        const href = await stageMedia(rec.dayDir, rec.file, 'files', `${rec.md5 || result.audit[i].ref.replace(':', '-')}.${ext}`);
        msg.attachments = [{ kind: 'file', href, name: rec.name, ...(rec.bytes ? { bytes: rec.bytes } : {}) }];
      }
      if (msg.attachments) validateAttachments(msg.attachments, 'weekly discussion attachments');
    }
    story.discussion = result.discussion;
    audit.push(...result.audit.map(row => ({ page: page.id, story: index, ...row })));
  }
  const counts = page.stories.map(story => story.discussion.length);
  console.log(JSON.stringify({ page: page.id, stories: counts.length, messages: counts.reduce((a, b) => a + b, 0), max: Math.max(0, ...counts), empty: counts.filter(n => !n).length }));
}
await writeFile(auditFile, JSON.stringify(audit, null, 2) + '\n', { mode: 0o600 });
await chmod(auditFile, 0o600);
await writeFile(readerFile, JSON.stringify(reader, null, 2) + '\n');
