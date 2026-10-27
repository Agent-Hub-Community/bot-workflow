import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildCandidate, validateReaderIssues } from '../../lib/finalize-batch.mjs';
import { load } from '../../lib/newspaper-root.mjs';
const { feedbackId } = await load('lib/feedback-id.mjs');
const { readerPage } = await load('lib/daily-generation.mjs');
const { pageGroups } = await load('lib/groups.mjs');
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../finalize-batch.mjs', import.meta.url));
const date = '2026-10-20';

function fixture() {
  const sources = pageGroups(date).map(({ id, label }, i) => {
    const input = { date, group: { id, label }, cutoff: `${date}T15:59:59Z`,
      messages: i ? [] : [{ id: 'm1', content: 'A fictional notebook uses a local queue. https://example.org/notebook' }],
    };
    const story = { category: 'Synthetic', title: 'Notebook queue', text: input.messages[0]?.content,
      topic_key: 'notebook', evidence_ids: ['m1'], claims: [{ kind: 'reported_experience', text: 'A local queue.', evidence_ids: ['m1'] }] };
    return { date, group: id, input, draft: { heading: 'Synthetic issue', theme: 'Invented material', stories: i ? [] : [story] } };
  });
  const issues = [{ id: date, date, label: 'Synthetic', pages: sources.map(source => readerPage(source.draft, source.input)) }];
  const attachments = { version: 1, stories: [{ date, group: 'group-1', topic_key: 'notebook',
    feedbackId: feedbackId(date, 'group-1', issues[0].pages[0].stories[0]),
    resources: [{ kind: 'article', label: 'Synthetic notebook', url: 'https://example.org/notebook' }],
    discussion: [{ speaker: 1, time: '10:00', text: 'A fictional notebook uses a local queue.' }],
    emphasis: ['local queue'], aiComment: 'The queue still needs a consumer.',
  }] };
  return { issues, sources, attachments, candidate() { return buildCandidate(this.issues, this.sources, this.attachments); } };
}

test('direct validation of complete reader issues', () => {
  const f = fixture();
  const story = f.issues[0].pages[0].stories[0];
  Object.assign(story, {
    resources: [{ kind: 'article', label: 'Synthetic notebook', url: 'https://example.org/notebook' }],
    discussion: [{ speaker: 1, time: '10:00', text: 'A fictional notebook uses a local queue.' }],
    emphasis: ['local queue'],
    aiComment: 'The queue still needs a consumer.',
  });
  assert.deepEqual(validateReaderIssues(f.issues), f.issues);
  assert.deepEqual(buildCandidate(f.issues).snapshot.issues, f.issues);
});

test('attachment manifest merges resources, discussion, emphasis and aiComment', () => {
  const f = fixture();
  const candidate = f.candidate();
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.snapshot.issues[0].pages[0].stories[0].aiComment, 'The queue still needs a consumer.');
});

test('manifest replaces stale emphasis after a body edit and unsupported resource kinds fail', () => {
  const f = fixture(), story = f.issues[0].pages[0].stories[0];
  story.emphasis = ['local queue'];
  story.text = story.text.replace('local queue', 'recovery log');
  f.attachments.stories[0].emphasis = ['recovery log'];
  assert.deepEqual(f.candidate().snapshot.issues[0].pages[0].stories[0].emphasis, ['recovery log']);
  f.attachments.stories[0].resources[0].kind = 'project';
  assert.throws(() => f.candidate(), /Unsupported reader resource kind/);
});

test('fail closed for invalid URLs, missing group, private fields and anonymous discussion leaks', async t => {
  const cases = {
    url: f => { f.attachments.stories[0].resources[0].url = 'javascript:alert(1)'; },
    query: f => { f.attachments.stories[0].resources[0].url += '?token=secret'; },
    group: f => { f.issues[0].pages.pop(); },
    field: f => { f.issues[0].pages[0].stories[0].topic_key = 'private'; },
    privateText: f => { f.attachments.stories[0].aiComment = 'Message from wxid_synthetic.'; },
    privateDiscussion: f => { f.attachments.stories[0].discussion[0].sender = 'private'; },
    privateQuote: f => { f.attachments.stories[0].discussion[0].quote = { speaker: 1, text: 'wxid_synthetic' }; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const f = fixture(); change(f); assert.throws(() => f.candidate());
  });
});

test('CLI finalizes batch in one step', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finalize-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), file = name => path.join(directory, name);
  await mkdir(file(date));
  await writeFile(file('issues.json'), JSON.stringify(f.issues));
  await writeFile(file('attachments.json'), JSON.stringify(f.attachments));
  for (const source of f.sources) {
    await writeFile(file(`${date}/${source.group}.input.json`), JSON.stringify(source.input));
    await writeFile(file(`${date}/${source.group}.draft.json`), JSON.stringify(source.draft));
  }
  const env = { ...process.env, DAILY_LLM_BASE_URL: 'http://127.0.0.1:1' };
  delete env.NODE_OPTIONS;
  const run = args => exec(process.execPath, [cli, ...args], { env, timeout: 10000 });
  await run(['--directory', directory, '--attachments', file('attachments.json'), '--out', file('final')]);
  assert.deepEqual(JSON.parse(await readFile(file('final/issues.json'), 'utf8')), f.candidate().snapshot.issues);
  await run([directory]);
  assert.deepEqual(JSON.parse(await readFile(file('final/issues.json'), 'utf8')), f.candidate().snapshot.issues);
});
