import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildCandidate, approveCandidate, validateReview } from '../../lib/finalize-batch.mjs';
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

test('explicit topic mapping, complete five groups, immutable inputs and idempotent candidate', () => {
  const f = fixture(), before = JSON.stringify(f);
  const candidate = f.candidate();
  assert.equal(candidate.status, 'pending');
  assert.deepEqual(f.candidate(), candidate);
  assert.equal(JSON.stringify(f), before);
  const review = approveCandidate(candidate, 'Fixture reviewer', '2026-10-22T12:00:00Z');
  assert.deepEqual(validateReview(candidate, review), candidate.snapshot.issues);
  assert.throws(() => validateReview(candidate, { ...review, status: 'pending' }), /approval/);
  assert.throws(() => validateReview(candidate, { ...review, reviewer: ' ' }), /reviewer/);
  assert.throws(() => approveCandidate(candidate, ''), /reviewer/);
});

test('every full-snapshot edit invalidates review even when feedbackId stays unchanged', async t => {
  const edits = {
    title: f => { f.issues[0].pages[0].stories[0].title += ' revised'; },
    body: f => { f.issues[0].pages[0].stories[0].text += ' Further detail.'; },
    header: f => { f.issues[0].pages[0].heading += ' revised'; },
    comment: f => { f.attachments.stories[0].aiComment = 'A revised fictional editorial observation.'; },
    resource: f => { f.attachments.stories[0].resources[0].label += ' revised'; },
    discussion: f => { f.attachments.stories[0].discussion[0].text += ' Revised.'; },
    emphasis: f => { f.attachments.stories[0].emphasis = []; },
    evidence: f => { f.sources[0].input.messages[0].content += ' New evidence.'; },
    draft: f => { f.sources[0].draft.theme += ' Revised.'; },
    inputComment: f => { f.issues[0].pages[0].stories[0].aiComment = 'A changed upstream comment.'; },
  };
  for (const [name, edit] of Object.entries(edits)) await t.test(name, () => {
    const f = fixture(), candidate = f.candidate(), review = approveCandidate(candidate, 'Reviewer');
    const oldId = f.attachments.stories[0].feedbackId;
    edit(f);
    if (name === 'title' || name === 'body') {
      assert.throws(() => f.candidate(), /Stale/);
      f.attachments.stories[0].feedbackId = feedbackId(date, 'group-1', f.issues[0].pages[0].stories[0]);
      assert.notEqual(f.attachments.stories[0].feedbackId, oldId);
    }
    assert.throws(() => validateReview(f.candidate(), review), /snapshot changed/);
  });
});

test('canonical resource requires explicit verified source mapping and binds the receipt', () => {
  const f = fixture(), entry = f.attachments.stories[0];
  const sourceUrl = entry.resources[0].url;
  entry.resources[0].url = 'https://example.org/canonical-notebook';
  assert.throws(() => f.candidate(), /Resource missing/);
  entry.resourceEvidence = [{ url: entry.resources[0].url, sourceUrl, reviewer: 'Fixture resource reviewer',
    reviewedAt: '2026-10-21T12:00:00Z', basis: 'Synthetic source explicitly names this canonical project; fixed evidence for tests.' }];
  const candidate = f.candidate(), review = approveCandidate(candidate, 'Editor');
  entry.resourceEvidence[0].basis += ' Revised.';
  assert.throws(() => validateReview(f.candidate(), review), /snapshot changed/);
  entry.resourceEvidence[0].sourceUrl = 'https://example.org/other-topic';
  assert.throws(() => f.candidate(), /source URL/);
  entry.resourceEvidence[0].sourceUrl = sourceUrl;
  delete entry.resourceEvidence[0].reviewer;
  assert.throws(() => f.candidate(), /reviewer/);
});

test('query removal needs explicit evidence, while Markdown delimiters preserve the source URL', () => {
  const f = fixture(), entry = f.attachments.stories[0];
  const clean = entry.resources[0].url, sourceUrl = `${clean}?share_id=42`;
  f.sources[0].input.messages[0].content = `Read [the notebook](${sourceUrl}).`;
  assert.throws(() => f.candidate(), /Resource missing/);
  entry.resourceEvidence = [{ url: clean, sourceUrl, reviewer: 'Fixture editor', reviewedAt: '2026-10-21T12:00:00Z',
    basis: 'Synthetic fixture explicitly verifies the clean address; no real network request.' }];
  assert.equal(f.candidate().snapshot.issues[0].pages[0].stories[0].resources[0].url, clean);
  entry.resourceEvidence[0].sourceUrl = clean;
  assert.throws(() => f.candidate(), /source URL/);
  delete entry.resourceEvidence;
  f.sources[0].input.messages[0].content = `Read [the notebook](${clean}).`;
  assert.ok(f.candidate());
});

test('manifest replaces stale emphasis after a body edit and unsupported resource kinds fail', () => {
  const f = fixture(), story = f.issues[0].pages[0].stories[0];
  story.emphasis = ['local queue'];
  story.text = story.text.replace('local queue', 'recovery log');
  f.attachments.stories[0].emphasis = ['recovery log'];
  f.attachments.stories[0].feedbackId = feedbackId(date, 'group-1', story);
  assert.deepEqual(f.candidate().snapshot.issues[0].pages[0].stories[0].emphasis, ['recovery log']);
  f.attachments.stories[0].resources[0].kind = 'project';
  assert.throws(() => f.candidate(), /Unsupported reader resource kind/);
});

test('reorder retains explicit attachments; missing, duplicate, unknown and stale mappings fail', () => {
  const f = fixture();
  const second = structuredClone(f.sources[0].draft.stories[0]);
  Object.assign(second, { topic_key: 'second', title: 'Second queue' });
  f.sources[0].draft.stories.push(second);
  const page = f.issues[0].pages[0];
  page.stories.push({ category: second.category, title: second.title, text: second.text });
  f.attachments.stories.push({ ...structuredClone(f.attachments.stories[0]), topic_key: 'second',
    feedbackId: feedbackId(date, 'group-1', second), aiComment: 'The second queue has its own consumer.' });
  page.stories.reverse();
  assert.equal(f.candidate().snapshot.issues[0].pages[0].stories[0].aiComment, 'The second queue has its own consumer.');
  f.attachments.stories.pop();
  assert.throws(() => f.candidate(), /Missing attachment/);
  f.attachments.stories.push(structuredClone(f.attachments.stories[0]));
  assert.throws(() => f.candidate(), /duplicate topic/);
  f.attachments.stories.pop();
  f.attachments.stories[0].topic_key = 'invented';
  assert.throws(() => f.candidate(), /Unknown/);
});

test('removed topics require explicit exclusion; new topics require original draft and evidence', () => {
  const f = fixture();
  f.issues[0].pages[0].stories = [];
  assert.throws(() => f.candidate(), /Stale/);
  f.attachments.stories = [{ date, group: 'group-1', topic_key: 'notebook', exclude: true, reason: 'Editorial removal' }];
  assert.deepEqual(f.candidate().snapshot.issues[0].pages[0].stories, []);
  const g = fixture();
  g.sources[0].draft.stories[0].evidence_ids = ['unknown'];
  assert.throws(() => g.candidate(), /evidence/);
  const h = fixture();
  h.sources[0].draft.stories.push(structuredClone(h.sources[0].draft.stories[0]));
  h.sources[0].draft.stories[1].title += ' another';
  assert.throws(() => h.candidate(), /Duplicate source topic/);
});

test('fail closed for invalid URLs, missing group, private fields and anonymous discussion leaks', async t => {
  const cases = {
    url: f => { f.attachments.stories[0].resources[0].url = 'javascript:alert(1)'; },
    inventedUrl: f => { f.attachments.stories[0].resources[0].url = 'https://example.org/invented'; },
    query: f => { f.attachments.stories[0].resources[0].url += '?token=secret'; },
    group: f => { f.issues[0].pages.pop(); },
    field: f => { f.issues[0].pages[0].stories[0].topic_key = 'private'; },
    privateText: f => { f.attachments.stories[0].aiComment = 'Message from wxid_synthetic.'; },
    privateDiscussion: f => { f.attachments.stories[0].discussion[0].sender = 'private'; },
    privateQuote: f => { f.attachments.stories[0].discussion[0].quote = { speaker: 1, text: 'wxid_synthetic' }; },
    emptyEmphasis: f => { delete f.attachments.stories[0].emphasis; },
    missingResource: f => { delete f.attachments.stories[0].resources; },
    missingDiscussion: f => { delete f.attachments.stories[0].discussion; },
    staleEvidence: f => { f.sources[0].input.messages[0].id = 'new'; },
    duplicateEvidence: f => { f.sources[0].input.messages.push(structuredClone(f.sources[0].input.messages[0])); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const f = fixture(); change(f); assert.throws(() => f.candidate());
  });
});

test('CLI requires explicit review, preserves source bytes, is atomic on failure and refuses overwrite', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finalize-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(), file = name => path.join(directory, name);
  await mkdir(file(date));
  const originals = new Map();
  const put = async (name, value) => {
    const content = JSON.stringify(value);
    await writeFile(file(name), content); originals.set(name, content);
  };
  await put('issues.json', f.issues);
  await put('attachments.json', f.attachments);
  for (const source of f.sources) {
    await put(`${date}/${source.group}.input.json`, source.input);
    await put(`${date}/${source.group}.draft.json`, source.draft);
    await put(`${date}/${source.group}.draft.json.response.json`, { untouched: true });
  }
  const env = { ...process.env, DAILY_LLM_BASE_URL: 'http://127.0.0.1:1' };
  delete env.NODE_OPTIONS;
  const run = args => exec(process.execPath, [cli, ...args], { env, timeout: 10000 });
  const common = ['--directory', directory, '--attachments', file('attachments.json')];
  await run(['candidate', ...common, '--out', file('candidate.json')]);
  await assert.rejects(run(['finalize', ...common, '--out', file('final')]), /--review/);
  await assert.rejects(run(['review', '--candidate', file('candidate.json'), '--reviewer', 'Editor', '--out', file('review.json')]), /--approve/);
  await assert.rejects(readFile(file('review.json')), { code: 'ENOENT' });
  const sign = ['review', '--candidate', file('candidate.json'), '--reviewer', 'Editor', '--approve', '--out', file('review.json')];
  await run(sign);
  const receiptBytes = await readFile(file('review.json'), 'utf8');
  await run(sign);
  assert.equal(await readFile(file('review.json'), 'utf8'), receiptBytes);
  const finish = ['finalize', ...common, '--review', file('review.json'), '--out', file('final')];
  await run(finish); await run(finish);
  assert.deepEqual(JSON.parse(await readFile(file('final/issues.json'), 'utf8')), f.candidate().snapshot.issues);
  for (const [name, content] of originals) assert.equal(await readFile(file(name), 'utf8'), content);
  f.issues[0].pages[0].heading = 'Revised heading';
  await writeFile(file('issues.json'), JSON.stringify(f.issues));
  await assert.rejects(run(['finalize', ...common, '--review', file('review.json'), '--out', file('failed')]), /snapshot changed/);
  await assert.rejects(readFile(file('failed/issues.json')), { code: 'ENOENT' });
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('.finalize-')));
  await assert.rejects(run(['candidate', ...common, '--out', file('candidate.json')]), /already exists/);
  await symlink(file('candidate.json'), file('link.json'));
  await assert.rejects(run(['candidate', ...common, '--out', file('link.json')]), /symlink/);
});
