import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmModel } from '../../lib/llm.mjs';
import { load, rootDir } from '../../lib/newspaper-root.mjs';

const { externalWindow, validateExternalReview } = await load('lib/external-workflow.mjs');

// The generators live here; the review receipt CLI stays in the newspaper checkout.
const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const reviewExternal = path.join(rootDir, 'scripts/review-external.mjs');
const selection = () => ({
  ...externalWindow('2026-09-26', '2026-09-26T19:00:00Z'),
  candidates: [{ id: 'product', kind: 'news', title: 'Product update', timing: 'September 25',
    selectionReason: 'Observed discussion and a verified announcement',
    attention: [{ platform: 'X', url: 'https://x.com/i/status/123', fetchedAt: '2026-09-25T19:00:00Z',
      observation: '1000 likes at this snapshot' }],
    sources: [{ publisher: 'Vendor', url: 'https://example.com/release', fetchedAt: '2026-09-25T19:00:00Z',
      text: 'The product enters private preview.' }],
  }],
});
const draft = () => ({
  date: '2026-09-26', title: 'Product enters preview', intro: 'A limited release.',
  stories: [{ candidateIds: ['product'], title: 'Preview', timing: 'September 25',
    text: 'The product enters private preview.', emphasis: ['preview'],
    aiComment: 'The waiting room has a release date.',
    links: [{ label: '官方发布', url: 'https://example.com/release' }] }], trends: [],
});
test('Gemini generator and review CLI round trip, fail closed for bad model and invented URL', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'external-workflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'selection.json'), output = path.join(dir, 'draft.json');
  const receipt = path.join(dir, 'review.json');
  await writeFile(input, JSON.stringify(selection()));
  let result = { model: llmModel, choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify(draft()) } }], usage: { total_tokens: 10 } };
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { env: { ...process.env, DAILY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } };
  const generate = () => run(process.execPath, [path.join(root, 'scripts/generate-external.mjs'), input, output], options);
  await generate();
  assert.equal(requests[0].model, llmModel);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), draft());
  await run(process.execPath, [reviewExternal, output, input, receipt, 'Editor', '--approve']);
  validateExternalReview(draft(), selection(), JSON.parse(await readFile(receipt, 'utf8')));
  result.model = 'wrong-model';
  await assert.rejects(generate(), /unexpected model/);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  result.model = llmModel;
  const bad = draft();
  bad.stories[0].links[0].url = 'https://invented.example/';
  result.choices[0].message.content = JSON.stringify(bad);
  await assert.rejects(generate(), /Unverified story link/);

  // Spans that break the emphasis rules are dropped instead of failing the draft, and the run record
  // names the story so the editor can pick its emphasis again.
  const overBudget = draft();
  overBudget.stories[0].emphasis = ['product', overBudget.stories[0].text, 'not in the text'];
  result.choices[0].message.content = JSON.stringify(overBudget);
  requests.length = 0;
  await generate();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')),
    { ...draft(), stories: [{ ...draft().stories[0], emphasis: ['product'] }] });
  assert.deepEqual(JSON.parse(await readFile(`${output}.run.json`, 'utf8')).emphasisTrimmed, ['Preview']);
});

test('external comments reuse the original prompt, map by ID and preserve approved copy', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'external-comments-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'draft.json'), output = path.join(dir, 'commented.json');
  const data = draft();
  delete data.stories[0].aiComment;
  data.stories.push({ ...structuredClone(data.stories[0]), candidateIds: ['other'],
    title: 'Another preview', text: 'Another product enters private preview.' });
  const original = JSON.stringify(data);
  await writeFile(input, original);
  let mode = 'valid';
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const stories = JSON.parse(request.messages[1].content);
    const entries = stories.map((story, i) => ({ id: story.id, comment: `Comment for article ${i + 1}.` })).reverse();
    if (mode === 'missing') entries.pop();
    if (mode === 'unknown') entries[0].id = 'invented';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: llmModel, choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(entries) } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const generate = target => run(process.execPath, [
    path.join(root, 'scripts/generate-external-comments.mjs'), input, target,
  ], { env: { ...process.env, DAILY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } });
  await generate(output);
  assert.equal(requests[0].model, llmModel);
  assert.equal(requests[0].messages[0].content, await readFile(path.join(root, 'prompts/daily-comment.md'), 'utf8'));
  const enriched = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(enriched, { ...data, stories: data.stories.map((story, i) => ({
    ...story, aiComment: `Comment for article ${i + 1}.`,
  })) });
  assert.equal(await readFile(input, 'utf8'), original);
  const reviewFile = path.join(dir, 'review.md');
  await writeFile(reviewFile, 'Keep token units and reporting actors precise.');
  await run(process.execPath, [
    path.join(root, 'scripts/generate-external-comments.mjs'), input, path.join(dir, 'revised.json'), reviewFile,
  ], { env: { ...process.env, DAILY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` } });
  assert.equal(requests[1].messages[0].content, requests[0].messages[0].content);
  assert.match(requests[1].messages[2].content, /Keep token units/);
  await generate(output);
  await assert.rejects(generate(input), /Usage:/);
  for (mode of ['missing', 'unknown']) {
    const failed = path.join(dir, `${mode}.json`);
    await assert.rejects(generate(failed), /coverage mismatch|Invalid comment/);
    await assert.rejects(readFile(failed), { code: 'ENOENT' });
  }
  const selectionFile = path.join(dir, 'selection.json'), receipt = path.join(dir, 'review.json');
  await writeFile(selectionFile, JSON.stringify(selection()));
  await writeFile(input, JSON.stringify({ ...data, stories: [data.stories[0]] }));
  await assert.rejects(run(process.execPath, [
    reviewExternal, input, selectionFile, receipt, 'Editor', '--approve',
  ]), /AI comments/);
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
});
