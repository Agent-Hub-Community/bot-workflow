import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmModel } from '../../lib/llm.mjs';

// Weekly groups come from the newspaper checkout's lib/groups.mjs: 五群 (group-5) is collected from
// 2026-10-16 and has a reader section from 2026-10-20.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const text = `alpha finding ${'.'.repeat(40)}`;

async function fixture(t, reply) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weekly-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: llmModel, choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(reply(requests.at(-1))) } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (script, args) => exec(process.execPath, [path.join(root, 'scripts', script), ...args], {
    env: { ...process.env, DAILY_LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }, timeout: 20000 });
  return { dir, requests, run };
}

async function writeInputs(dir, days) {
  for (const [date, ids] of Object.entries(days)) {
    await mkdir(path.join(dir, date), { recursive: true });
    for (const id of ids) {
      await writeFile(path.join(dir, date, `${id}.input.json`), JSON.stringify({
        group: { id }, date, messages: [{ id: 'm1', speaker: 'p1', content: `${id} on ${date}` }],
      }));
    }
  }
}

const page = { title: 'A week', intro: 'Grounded.', stories: [{ title: 'Story', text, review: 'Bounded.', emphasis: ['alpha'] }] };
const week = (from, count) => Array.from({ length: count }, (_, i) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const groupsIn = request => request.messages[0].content.match(/群别：(group-\d+)/)[1];

test('weekly drafts default to the groups with a section that week, including 五群 from its first section week', async t => {
  const f = await fixture(t, () => page);
  const before = week('2026-10-12', 7), after = week('2026-10-19', 7);
  const four = ['group-1', 'group-2', 'group-3', 'group-4'];
  await writeInputs(f.dir, Object.fromEntries([
    ...before.map(date => [date, date >= '2026-10-16' ? [...four, 'group-5'] : four]),
    ...after.map(date => [date, [...four, 'group-5']]),
  ]));

  await f.run('generate-weekly-gemini.mjs', ['2026-10-19', '2026-10-25', f.dir, path.join(f.dir, 'late')]);
  assert.deepEqual(f.requests.map(groupsIn).sort(), [...four, 'group-5']);
  assert.deepEqual((await readdir(path.join(f.dir, 'late'))).filter(name => /^group-\d\.json$/.test(name)).sort(),
    [...four, 'group-5'].map(id => `${id}.json`));

  f.requests.length = 0;
  await f.run('generate-weekly-gemini.mjs', ['2026-10-12', '2026-10-18', f.dir, path.join(f.dir, 'early')]);
  assert.deepEqual(f.requests.map(groupsIn).sort(), four, 'collected but without a section: not in the default');

  // Asked for explicitly, 五群 reads only the days it was collected (from 2026-10-16).
  f.requests.length = 0;
  const [result] = JSON.parse((await f.run('generate-weekly-gemini.mjs',
    ['2026-10-12', '2026-10-18', f.dir, path.join(f.dir, 'fifth'), '--groups', 'group-5'])).stdout);
  assert.deepEqual(result, { group: 'group-5', messages: 3, stories: 1 });
  await assert.rejects(f.run('generate-weekly-gemini.mjs',
    ['2026-10-19', '2026-10-25', f.dir, path.join(f.dir, 'bad'), '--groups', 'group-1,group-9']), /Unknown group: group-9/);
});

test('weekly emphasis covers every group page from lib/groups.mjs and the external page', async t => {
  const f = await fixture(t, request => JSON.parse(request.messages[1].content)
    .map(story => ({ id: story.id, emphasis: ['alpha'] })));
  for (const id of ['group-1', 'group-5', 'external', 'group-9']) {
    await writeFile(path.join(f.dir, `${id}.json`), JSON.stringify({ ...page, id,
      stories: [{ ...page.stories[0], emphasis: [] }] }));
  }
  await f.run('generate-weekly-emphasis.mjs', [f.dir]);
  const ids = f.requests.map(request => JSON.parse(request.messages[1].content)[0].id.split(':')[0]).sort();
  assert.deepEqual(ids, ['external', 'group-1', 'group-5']);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'group-5.json'), 'utf8')).stories[0].emphasis, ['alpha']);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'group-9.json'), 'utf8')).stories[0].emphasis, []);
});
