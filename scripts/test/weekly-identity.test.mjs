import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../../lib/newspaper-root.mjs';
import {
  namespaceInput, modelMessages, evidenceMessages, prepareMessages, compareRefs, quoteOf,
  resolveQuoteTarget, buildDiscussion, selectDiscussion, validateDiscussionAudit,
} from '../../lib/weekly-discussion.mjs';
const { sanitizeInput } = await load('lib/daily-generation.mjs');
const { modelInput } = await load('lib/image-messages.mjs');
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const first = '2026-10-20', second = '2026-10-21', group = 'group-1';
const original = 'The original question has enough detail to establish its source.';
const another = 'Today we discuss a different constraint with a different author.';

function day(date, rows, id = group) {
  const raw = rows.map((row, i) => ({ sender: row.sender ?? 'Alice', time: `${date} 10:${String(i).padStart(2, '0')}:00`,
    type: row.type || '文本', content: row.content, local_id: i + 1 }));
  const input = sanitizeInput({ date, group: { id }, messages: rows.map((row, i) => ({
    id: row.id || `m${String(i + 1).padStart(4, '0')}`, time: raw[i].time, type: raw[i].type,
    speaker: row.speaker || 'p1', content: row.content, ...(row.image ? { image: row.image } : {}),
  })) });
  return { date, group: id, raw, input };
}
function sample() {
  return [day(first, [
    { content: original },
    { content: 'Alice added a second concrete observation.' },
  ]), day(second, [
    { sender: 'Bob', speaker: 'p1', content: another },
    { sender: 'Alice', speaker: 'p2', content: `[引用] I answer the older question.\n  ↳ Alice: ${original}` },
    { sender: 'Cathy', speaker: 'p3', content: `[引用] Bob, the constraint is useful.  ↳ Bob: ${another}` },
  ])];
}
const prepare = days => prepareMessages(days, { sanitizeInput });

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weekly-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const json = async (name, data) => {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return file;
  };
  // CLI fixture without any external LLM mocks.
  const run = (script, args) => exec(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root, timeout: 20000, env: process.env,
  });
  return { dir, json, run };
}

test('daily identity namespace is idempotent and refuses mismatched dates, groups and duplicate refs', () => {
  const { input } = sample()[0];
  const result = namespaceInput(input, first, group);
  assert.equal(result.messages[0].speaker, `${first}/${group}/p1`);
  assert.deepEqual(namespaceInput(result, first, group), result);
  assert.equal(input.messages[0].speaker, 'p1');
  for (const speaker of [`${second}/${group}/p1`, `${first}/group-2/p1`, `${first}/${group}/p0`]) {
    const bad = structuredClone(input); bad.messages[0].speaker = speaker;
    assert.throws(() => namespaceInput(bad, first, group), /namespace mismatch/);
  }
  assert.throws(() => namespaceInput(input, second, group), /mismatch/);
  assert.throws(() => namespaceInput(input, first, 'group-2'), /mismatch/);
  const dup = structuredClone(input); dup.messages[1].id = 'm1';
  assert.throws(() => namespaceInput(dup, first, group), /Duplicate/);
  const wrongRef = structuredClone(input); wrongRef.messages[0].ref = `${second}:m0001`;
  assert.throws(() => namespaceInput(wrongRef, first, group), /ref mismatch/);
  assert.throws(() => namespaceInput({ ...input, sources: ['one', 'two'] }, first, group), /one source/);
});

test('preparation rejects multi-source days and raw/input misalignment, even when lengths agree', () => {
  const source = sample()[0];
  assert.throws(() => prepare([source, source]), /Multiple sources/);
  assert.throws(() => prepare([source, day(second, [], 'group-2')]), /one group/);
  for (const field of ['time', 'type', 'content']) {
    const bad = structuredClone(source); bad.raw[0][field] += 'wrong';
    assert.throws(() => prepare([bad]), /alignment/);
  }
  const swapped = structuredClone(source); swapped.raw.reverse();
  assert.throws(() => prepare([swapped]), /alignment/);
  const missing = structuredClone(source); delete missing.raw[0].time;
  assert.throws(() => prepare([missing]), /alignment/);
  const sender = structuredClone(source); sender.raw[1].sender = 'Someone else';
  assert.throws(() => prepare([sender]), /Inconsistent daily speaker/);
  const sanitized = day(first, [{ content: 'Contact wxid_testperson\u0000 for details.' }]);
  assert.notEqual(sanitized.raw[0].content, sanitized.input.messages[0].content);
  assert.equal(prepare([sanitized])[0].content, sanitized.input.messages[0].content);
});

test('same-day p1 repeats but cross-day p1 and cross-day nickname never merge', () => {
  const all = prepare(sample()), refs = all.map(m => m.ref);
  const { discussion, audit } = buildDiscussion(all, refs);
  assert.deepEqual(discussion.map(m => m.speaker), [1, 1, 2, 3, 4]);
  assert.equal(discussion[3].quote.speaker, 1);
  assert.equal(discussion[4].quote.speaker, 2);
  assert.equal(audit[3].quoteTarget, `${first}:m0001`);
  assert.equal(audit[3].sourceSpeaker, `${second}/${group}/p2`);
  assert.ok(discussion.every(m => m.continues === false));
  assert.equal(discussion[1].text, 'Alice added a second concrete observation.');
  assert.equal(discussion[4].text, 'Bob, the constraint is useful.');
  assert.doesNotMatch(JSON.stringify(discussion), /Cathy|sourceSpeaker|quoteTarget|m000|group-1|rawSender|↳/);
  assert.ok(discussion.every(m => Object.keys(m).every(key => ['speaker', 'time', 'text', 'quote', 'continues'].includes(key))));
  validateDiscussionAudit(discussion, audit);
});

test('quote formats, strict numeric order and exact unique attribution establish links', () => {
  assert.deepEqual(quoteOf('[引用] First line\nsecond line\n ↳ Alice: quoted\ncontinued'),
    { body: 'First line\nsecond line', sender: 'Alice', text: 'quoted\ncontinued' });
  assert.equal(quoteOf('[引用] Reply  ↳ Alice： quoted').sender, 'Alice');
  const all = prepare([day(first, [
    { id: 'm9999', content: original },
    { id: 'm10000', sender: 'Bob', speaker: 'p2', content: `[引用] Reply\n ↳ Alice: ${original}` },
  ])]);
  assert.ok(compareRefs(`${first}:m9999`, `${first}:m10000`) < 0);
  assert.equal(resolveQuoteTarget(all[1], all)?.ref, `${first}:m9999`);
  const future = structuredClone(all); future[0].id = 'm10001'; future[0].ref = `${first}:m10001`;
  assert.equal(resolveQuoteTarget(future[1], future), null);
  const duplicate = { ...all[0], id: 'm9998', ref: `${first}:m9998` };
  assert.equal(resolveQuoteTarget(all[1], [...all, duplicate]), null);
  assert.equal(resolveQuoteTarget(all[1], [all[1]]), null);
  assert.equal(resolveQuoteTarget({ ...all[1], content: `[引用] Reply  ↳ Unknown: ${original}` }, all), null);
  assert.equal(resolveQuoteTarget({ ...all[1], content: `[引用] Reply  ↳ Alice: ${original.slice(0, 25)}` }, all), null);
  for (const mark of ['...', '…', '[...]']) {
    assert.equal(resolveQuoteTarget({ ...all[1], content: `[引用] Reply  ↳ Alice: ${original.slice(0, 25)}${mark}` }, all)?.ref, all[0].ref);
  }
  assert.equal(resolveQuoteTarget({ ...all[1], content: `[引用] Reply  ↳ Alice: ${original.slice(0, 19)}...` }, all), null);
  const media = prepare([day(first, [{ content: '[图片]', type: '图片' },
    { sender: 'Bob', speaker: 'p2', content: '[引用] Reply  ↳ Alice: [图片]' }])]);
  assert.equal(resolveQuoteTarget(media[1], media), null);
});

test('unknown quotes anonymize generically; known quotes use the target day, not the reply day', () => {
  const all = prepare([day(first, [{ content: 'Alice described a reproducible test in several careful steps.' }]), day(second, [
    { sender: 'Alice', content: 'An unrelated proposal today.' },
    { sender: 'Bob', speaker: 'p2', content: '[引用] A reply  ↳ Alice: Alice described a reproducible test in several careful steps.' },
    { sender: 'Cathy', speaker: 'p3', content: '[引用] Another reply  ↳ Unknown: Alice made an unrecorded statement.' },
  ])]);
  const { discussion } = buildDiscussion(all, all.map(m => m.ref), { maskNames: true });
  assert.match(discussion[2].quote.text, /^群友 1 described/);
  assert.match(discussion[3].quote.text, /^群友 made/);
  assert.equal(discussion[3].quote.speaker, null);
});

test('nickname replacement uses whole English words and longest names first', () => {
  const all = prepare([day(first, [
    { sender: 'allen', content: 'allen answers a challenge; CHALLENGE stays. @allen，allen哥 agrees.' },
    { sender: 'allen smith', speaker: 'p2', content: 'allen smith meets allen; allensmith is a separate token.' },
    { sender: 'longname', speaker: 'p3', content: 'longname and longnameSuffix are distinct.' },
  ])]);
  const { discussion } = buildDiscussion(all, all.map(m => m.ref), { maskNames: true });
  assert.equal(discussion[0].text, '群友 1 answers a challenge; CHALLENGE stays. @群友 1，群友 1哥 agrees.');
  assert.equal(discussion[1].text, '群友 2 meets 群友 1; allensmith is a separate token.');
  assert.equal(discussion[2].text, '群友 3 and longnameSuffix are distinct.');
});

test('nickname masking preserves sanitized public URLs in messages and quotes', () => {
  const url = 'https://github.com/allen/project';
  const text = `allen shared ${url}，allen can answer follow-up questions.`;
  const all = prepare([day(first, [
    { sender: 'allen', content: text },
    { sender: 'Bob', speaker: 'p2', content: `[引用] I checked ${url}.  ↳ allen: ${text}` },
  ])]);
  const { discussion } = buildDiscussion(all, all.map(m => m.ref), { maskNames: true });
  assert.equal(discussion[0].text, `群友 1 shared ${url}，群友 1 can answer follow-up questions.`);
  assert.equal(discussion[1].text, `I checked ${url}.`);
  assert.equal(discussion[1].quote.text, discussion[0].text);
  assert.equal(discussion[1].quote.speaker, 1);
});

test('selection preserves gaps, text labels and original audit across repeated passes', () => {
  const all = prepare(sample()), initial = buildDiscussion(all, all.map(m => m.ref));
  const selected = selectDiscussion(initial.discussion, [2, 3, 4], initial.audit);
  assert.deepEqual(selected.discussion.map(m => m.speaker), [2, 3, 4]);
  assert.equal(selected.discussion[1].quote.speaker, null);
  assert.equal(selected.discussion[2].quote.speaker, 2);
  assert.equal(selected.discussion[2].text, initial.discussion[4].text);
  assert.match(selected.discussion[2].text, /Bob/);
  assert.equal(selected.audit[1].quoteTarget, `${first}:m0001`);
  assert.equal(selected.audit[1].quoteSpeaker, 1);
  const samePersonDifferentMessage = selectDiscussion(initial.discussion, [1, 3], initial.audit);
  assert.equal(samePersonDifferentMessage.discussion[0].speaker, 1);
  assert.equal(samePersonDifferentMessage.discussion[1].quote.speaker, null, 'a retained speaker cannot stand in for the deleted quoted message');
  assert.deepEqual(selectDiscussion(selected.discussion, [0, 1, 2], selected.audit), selected);
  const noAudit = selectDiscussion(initial.discussion, [0, 3]);
  assert.equal(noAudit.discussion[1].quote.speaker, null);
  assert.equal(noAudit.audit, null);
  const corrupted = structuredClone(initial.audit); corrupted.reverse();
  assert.throws(() => selectDiscussion(initial.discussion, [0], corrupted), /alignment/);
  const gaps = [1, 3, 7].map(speaker => ({ speaker, time: '10.20 10:00', text: `群友 ${speaker} shared evidence.`, continues: true }));
  assert.deepEqual(selectDiscussion(gaps, [1, 2]).discussion.map(m => m.speaker), [3, 7]);
  assert.ok(selectDiscussion(gaps, [1, 2]).discussion.every(m => !m.continues));
});

test('quote expansion never reintroduces excluded targets and never uses images as testimony', () => {
  const all = prepare(sample());
  const result = buildDiscussion(all, [`${second}:m0002`], { excludedRefs: [`${first}:m0001`] });
  assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].quote, undefined);
  assert.equal(result.audit[0].quoteTarget, `${first}:m0001`);
  const removedQuote = buildDiscussion(all, [`${second}:m0002`], { removeQuoteRefs: [`${second}:m0002`] });
  assert.equal(removedQuote.discussion.length, 1);
  assert.equal(removedQuote.discussion[0].quote, undefined);
  const images = day(first, [{ content: '[图片]', type: '图片', image: { description: 'Secret model interpretation', quality: 'original' } }]);
  const model = modelMessages(images.input, first, group, modelInput), evidence = evidenceMessages(images.input, first, group);
  const discussion = buildDiscussion(prepare([images]), [`${first}:m0001`]).discussion;
  assert.match(model[0].content, /Secret model interpretation/);
  assert.match(evidence[0].c, /Secret model interpretation/);
  assert.equal(model[0].speaker, `${first}/${group}/p1`);
  assert.equal(evidence[0].s, `${first}/${group}/p1`);
  assert.equal(discussion[0].text, '[图片]');
  assert.doesNotMatch(JSON.stringify(discussion), /Secret|description|image/);
});

test('attach CLI applies exclusions before quote completion and fails closed on raw misalignment', async t => {
  const f = await fixture(t);
  for (const source of sample()) {
    await f.json(`inputs/${source.date}/${group}.input.json`, source.input);
    await f.json(`inputs/${source.date}/${group}.raw.json`, source.raw);
  }
  const readerFile = await f.json('reader.json', { from: first, through: second, pages: [{ id: group, stories: [{ title: 'Synthetic' }] }] });
  await f.json(`evidence/${group}.evidence.json`, { group, evidence: { 0: [`${second}:m0002`] } });
  const exclusions = await f.json('exclusions.json', { exclude: [{ group, ref: `${first}:m0001` }] });
  const args = [readerFile, path.join(f.dir, 'inputs'), path.join(f.dir, 'evidence'), path.join(f.dir, 'audit.json'), '--exclusions', exclusions];
  await f.run('weekly-attach-discussions.mjs', args);
  const discussion = JSON.parse(await readFile(readerFile, 'utf8')).pages[0].stories[0].discussion;
  assert.equal(discussion.length, 1);
  assert.equal(discussion[0].quote, undefined);
  const badRaw = sample()[0].raw; badRaw.reverse();
  await f.json(`inputs/${first}/${group}.raw.json`, badRaw);
  await assert.rejects(f.run('weekly-attach-discussions.mjs', args), /alignment mismatch/);
});
