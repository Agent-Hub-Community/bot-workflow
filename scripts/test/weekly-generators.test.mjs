import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmModel } from '../../lib/llm.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const day = '2026-10-20';
const text = `alpha finding with beta detail ${'.'.repeat(60)}`;
const story = (extra = {}) => ({ title: 'Story', text, review: 'Bounded.', emphasis: ['alpha'], ...extra });
const page = (extra = {}) => ({ title: 'A week', intro: 'Grounded.', stories: [story(extra)] });

// A local chat-completions server; reply(request) returns the JSON the model would write.
async function fixture(t, reply) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weekly-generators-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    if (reply.status) {
      res.statusCode = reply.status;
      return res.end('{}');
    }
    res.end(JSON.stringify({ model: llmModel, choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(reply.current(requests.at(-1))) } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = async (script, args) => {
    try {
      const { stdout, stderr } = await exec(process.execPath, [path.join(root, 'scripts', script), ...args], {
        env: { ...process.env, DAILY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 20000 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const json = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  return { dir, requests, run, json };
}

const groupOf = request => request.messages[0].content.match(/群别：(group-\d+)/)[1];

test('weekly drafts: groups fail independently, spans are trimmed, saved responses are reused and --force reruns', async t => {
  const reply = { current: request => groupOf(request) === 'group-1'
    ? page({ emphasis: ['alpha', 'alpah miscopied'] })
    : { ...page(), stories: [{ title: 'No text', review: 'x', emphasis: [] }] } };
  const f = await fixture(t, reply);
  for (const id of ['group-1', 'group-2']) {
    await mkdir(path.join(f.dir, 'in', day), { recursive: true });
    await writeFile(path.join(f.dir, 'in', day, `${id}.input.json`), JSON.stringify({
      group: { id }, date: day, messages: [{ id: 'm1', speaker: 'p1', content: `${id} news` }] }));
  }
  const out = path.join(f.dir, 'out');
  const draft = (...extra) => f.run('generate-weekly-gemini.mjs', [day, day, path.join(f.dir, 'in'), out, '--groups', 'group-1,group-2', ...extra]);

  let result = await draft();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed groups: group-2/);
  assert.deepEqual(JSON.parse(result.stdout), [
    { group: 'group-1', messages: 1, stories: 1, emphasisDropped: 1 },
    { group: 'group-2', error: 'group-2: invalid story shape' },
  ]);
  assert.deepEqual((await f.json('out/group-1.json')).stories[0].emphasis, ['alpha']);
  assert.deepEqual((await f.json('out/group-1.run.json')).emphasisDropped,
    [{ story: 0, title: 'Story', phrase: 'alpah miscopied', reason: 'not-in-text' }]);
  assert.ok(existsSync(path.join(out, 'group-2.response.json')));
  assert.ok(!existsSync(path.join(out, 'group-2.json')));

  // group-1 is done and skipped; group-2's saved response fails again, so only group-2 reaches the model.
  reply.current = () => page();
  f.requests.length = 0;
  result = await draft();
  assert.equal(result.code, 0);
  assert.deepEqual(f.requests.map(groupOf), ['group-2']);
  assert.deepEqual(JSON.parse(result.stdout), [
    { group: 'group-1', skipped: 'exists' },
    { group: 'group-2', messages: 1, stories: 1 },
  ]);
  assert.equal((await f.json('out/group-2.run.json')).reuseError, 'group-2: invalid story shape');

  // A page lost after its response was saved is rebuilt from that response without a model call.
  await rm(path.join(out, 'group-1.json'));
  f.requests.length = 0;
  result = await draft();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(JSON.parse(result.stdout)[0], { group: 'group-1', messages: 1, stories: 1, reusedResponse: true, emphasisDropped: 1 });
  assert.deepEqual((await f.json('out/group-1.json')).stories[0].emphasis, ['alpha']);

  // Changed input makes the saved response stale, so it is not reused.
  await rm(path.join(out, 'group-1.json'));
  await writeFile(path.join(f.dir, 'in', day, 'group-1.input.json'), JSON.stringify({
    group: { id: 'group-1' }, date: day, messages: [{ id: 'm1', speaker: 'p1', content: 'corrected news' }] }));
  f.requests.length = 0;
  result = await draft();
  assert.deepEqual(f.requests.map(groupOf), ['group-1']);
  assert.deepEqual((await f.json('out/group-1.json')).stories[0].emphasis, ['alpha']);

  // A failed request after a prompt change must not leave the old response to be reused for the new prompt.
  await rm(path.join(out, 'group-1.json'));
  await writeFile(path.join(f.dir, 'in', day, 'group-1.input.json'), JSON.stringify({
    group: { id: 'group-1' }, date: day, messages: [{ id: 'm1', speaker: 'p1', content: 'second correction' }] }));
  reply.status = 500;
  f.requests.length = 0;
  result = await draft();
  assert.equal(result.code, 1);
  assert.deepEqual(f.requests.map(groupOf), ['group-1']);
  assert.deepEqual(JSON.parse(result.stdout)[0], { group: 'group-1', error: 'group-1: HTTP 500' });
  reply.status = undefined;
  reply.current = () => page({ title: 'Fresh' });
  f.requests.length = 0;
  result = await draft();
  assert.equal(result.code, 0);
  assert.deepEqual(f.requests.map(groupOf), ['group-1']);
  assert.match(f.requests[0].messages[0].content, /second correction/);
  assert.deepEqual(JSON.parse(result.stdout)[0], { group: 'group-1', messages: 1, stories: 1 });
  assert.equal((await f.json('out/group-1.json')).stories[0].title, 'Fresh');

  f.requests.length = 0;
  result = await draft('--force');
  assert.equal(result.code, 0);
  assert.deepEqual(f.requests.map(groupOf).sort(), ['group-1', 'group-2']);
});

test('weekly emphasis: pages fail independently, ids fall back to the file name and pages can be selected', async t => {
  const reply = { current: request => {
    const stories = JSON.parse(request.messages[1].content);
    if (stories[0].id.startsWith('group-2:')) return [];
    return stories.map(({ id }) => ({ id, emphasis: ['alpha finding', 'beta detial'] }));
  } };
  const f = await fixture(t, reply);
  await writeFile(path.join(f.dir, 'group-1.json'), JSON.stringify(page({ emphasis: [] })));
  await writeFile(path.join(f.dir, 'group-2.json'), JSON.stringify({ id: 'group-2', ...page({ emphasis: [] }) }));
  await writeFile(path.join(f.dir, 'external.json'), JSON.stringify({ id: 'external', ...page({ emphasis: [] }) }));

  let result = await f.run('generate-weekly-emphasis.mjs', [f.dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /group-2\.json: FAILED group-2\.json: invalid or incomplete emphasis response/);
  assert.deepEqual(f.requests.map(request => JSON.parse(request.messages[1].content)[0].id).sort(),
    ['external:0', 'group-1:0', 'group-2:0']);
  assert.deepEqual((await f.json('group-1.json')).stories[0].emphasis, ['alpha finding']);
  assert.deepEqual((await f.json('external.json')).stories[0].emphasis, ['alpha finding']);
  assert.deepEqual((await f.json('group-2.json')).stories[0].emphasis, []);
  assert.deepEqual((await f.json('group-1.json.emphasis.run.json')).emphasisDropped,
    [{ story: 0, title: 'Story', phrase: 'beta detial', reason: 'not-in-text' }]);

  reply.current = request => JSON.parse(request.messages[1].content).map(({ id }) => ({ id, emphasis: ['beta detail'] }));
  f.requests.length = 0;
  result = await f.run('generate-weekly-emphasis.mjs', [f.dir, 'group-2.json', '--pages', 'external']);
  assert.equal(result.code, 0);
  assert.deepEqual(f.requests.map(request => JSON.parse(request.messages[1].content)[0].id).sort(), ['external:0', 'group-2:0']);
  assert.deepEqual((await f.json('group-2.json')).stories[0].emphasis, ['beta detail']);
  assert.deepEqual((await f.json('group-1.json')).stories[0].emphasis, ['alpha finding'], 'unselected page untouched');

  result = await f.run('generate-weekly-emphasis.mjs', [f.dir, 'group-99']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown weekly page: group-99\.json/);
});
