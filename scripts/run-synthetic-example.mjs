import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { dates, model, dailyInput, dailyDraft, selection, externalDraft, activity, comment, emphasis, resourceUrl } from '../examples/synthetic/fixtures.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, 'Use --out DIRECTORY; NEWSPAPER_DIR optionally names a clean newspaper clone');
const { rootDir: newspaperDir } = await import('../lib/newspaper-root.mjs');
const newspaper = await realpath(newspaperDir);
const out = path.resolve(values.out);
const marker = { kind: 'bot-workflow-synthetic', version: 1 };
const json = file => readFile(file, 'utf8').then(JSON.parse);
async function exists(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const stat = await exists(out);
const parent = await realpath(path.dirname(out));
const destination = path.join(parent, path.basename(out));
assert.ok(destination !== newspaper && !destination.startsWith(newspaper + path.sep) && !newspaper.startsWith(destination + path.sep),
  'Synthetic output must be separate from the newspaper checkout');
if (stat) {
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Refuse a symlink or non-directory output');
  const mark = path.join(destination, '.synthetic-example.json');
  assert.ok(!(await lstat(mark)).isSymbolicLink(), 'Refuse a symlink marker');
  assert.deepEqual(await json(mark), marker, 'Existing directory is not marked as a synthetic example');
}
// An allowlist avoids inheriting model credentials, wx paths, proxy settings and Node preload hooks.
const cleanEnv = { PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TZ: 'UTC',
  NEWSPAPER_DIR: newspaper, DAILY_LLM_MODEL: model };
await readFile(path.join(newspaper, 'node_modules/linkedom/package.json'));
if (!stat) {
  await mkdir(destination, { mode: 0o700 });
  await writeFile(path.join(destination, '.synthetic-example.json'), JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
}
const runDirectory = await mkdtemp(path.join(destination, 'run-'));
const home = path.join(runDirectory, 'home');
await mkdir(home, { mode: 0o700 });
cleanEnv.HOME = home;
cleanEnv.TMPDIR = runDirectory;
const save = async (file, data) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
};
const { load } = await import('../lib/newspaper-root.mjs');
const { pageGroups } = await load('lib/groups.mjs');
const { feedbackId } = await load('lib/feedback-id.mjs');
const { validatePublicActivity } = await load('lib/public-activity.mjs');
const { validateExternalReview } = await load('lib/external-workflow.mjs');
const { namespaceInput } = await import('../lib/weekly-discussion.mjs');
const groups = pageGroups(dates[1]);
assert.equal(groups.length, 5, 'Example expects the five reader groups');
const batch = path.join(runDirectory, 'batch');
for (const date of dates) for (const group of groups) {
  const { input, raw } = dailyInput(date, group);
  await save(path.join(batch, date, `${group.id}.input.json`), input);
  await save(path.join(batch, date, `${group.id}.raw.json`), raw);
  await save(path.join(runDirectory, 'namespaced', date, `${group.id}.input.json`), namespaceInput(input, date, group.id));
}

// This HTTP server is a test double for a chat-completions API, not a frontend dev server.
let stage = 'daily';
const requests = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, undefined, 'The fixture must never receive real credentials');
    let bytes = '';
    for await (const chunk of req) { bytes += chunk; assert.ok(bytes.length < 1000000); }
    const body = JSON.parse(bytes);
    assert.equal(body.model, model);
    const user = body.messages.find(message => message.role === 'user').content;
    let response;
    if (stage === 'daily') response = dailyDraft(JSON.parse(user));
    else if (stage === 'enrich' || stage === 'external-comments') {
      const items = JSON.parse(user);
      response = items.map(item => Object.hasOwn(item, 'note')
        ? { id: item.id, heading: '合成社区的离线笔记测试', theme: '先验证恢复，再比较导出' }
        : body.messages[0].content.includes('emphasis')
          ? { id: item.id, emphasis }
          : { id: item.id, comment });
    } else if (stage === 'external') response = structuredClone(externalDraft);
    else if (stage === 'evidence') {
      const [topicsLine, messagesLine] = user.split('\n');
      const topics = JSON.parse(topicsLine.slice(topicsLine.indexOf('[')));
      const messages = JSON.parse(messagesLine.slice(messagesLine.indexOf('[')));
      assert.equal(topics.length, 1);
      response = [{ i: topics[0].i, refs: messages.map(message => message.ref) }];
    } else if (stage === 'select') response = { keep: [0, 1, 2, 3] };
    else throw new Error(`Unexpected fixture stage ${stage}`);
    requests.push({ stage, model: body.model, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
cleanEnv.DAILY_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
const commands = [];
async function run(script, args, cwd = root) {
  const result = await exec(process.execPath, [script, ...args], { env: cleanEnv, cwd, timeout: 120000, maxBuffer: 4000000 });
  commands.push({ script: path.basename(script), args, stdout: result.stdout });
}
const bot = (script, args) => run(path.join(root, 'scripts', script), args);
try {
  await bot('prepare-week-d.mjs', ['generate', ...dates, batch, '--emphasis']);
  await bot('prepare-week-d.mjs', ['package', ...dates, batch, '--emphasis']);
  stage = 'enrich';
  await bot('enrich-month-d.mjs', [batch]);
  const issues = await json(path.join(batch, 'issues.json'));
  // The weekly path is exercised independently, with fixed evidence selection and no real identities.
  const weekly = path.join(runDirectory, 'weekly.json');
  await save(weekly, { from: dates[0], through: dates[1], pages: issues[0].pages.map(page => ({
    id: page.id, label: page.label, stories: page.stories.map(story => ({ ...story, dates })),
  })) });
  const evidence = path.join(runDirectory, 'weekly-evidence'), audit = path.join(runDirectory, 'discussion-audit.json');
  stage = 'evidence';
  await bot('weekly-discussion-evidence.mjs', [weekly, batch, evidence]);
  await bot('weekly-attach-discussions.mjs', [weekly, batch, evidence, audit]);
  stage = 'select';
  await bot('weekly-select-discussion.mjs', [weekly, path.join(runDirectory, 'weekly-selection'), '--max', '3', '--audit', audit]);
  const selected = await json(weekly), identity = await json(audit);
  for (const page of selected.pages.filter(page => page.stories.length)) {
    const rows = identity.filter(row => row.page === page.id && row.story === 0);
    assert.equal(new Set(rows.map(row => row.sourceSpeaker)).size, 4);
    assert.equal(new Set(page.stories[0].discussion.map(message => message.speaker)).size, 4);
    assert.equal(rows.at(-1).quoteTarget, `${dates[0]}:m0001`);
    assert.equal(page.stories[0].discussion.at(-1).quote.speaker, page.stories[0].discussion[0].speaker);
  }
  const attachments = { version: 1, stories: [] };
  for (const issue of issues) {
    issue.label = `${issue.date} 合成日报`;
    for (const page of issue.pages) {
      page.note = `${issue.date} · Synthetic 合成数据、虚构榜单与自绘头像${page.stories.length ? '' : ' · 合成空组'}`;
      const draft = await json(path.join(batch, issue.date, `${page.id}.draft.json`));
      // The fixture declares a single topic. No title, position or fuzzy join is used by the finalizer.
      assert.ok(draft.stories.every(story => story.topic_key === 'synthetic-notebook'));
      for (const story of page.stories) {
        const discussion = selected.pages.find(item => item.id === page.id).stories[0].discussion;
        const rows = identity.filter(row => row.page === page.id && row.story === 0 && row.ref.startsWith(issue.date));
        attachments.stories.push({ date: issue.date, group: page.id, topic_key: 'synthetic-notebook',
          feedbackId: feedbackId(issue.date, page.id, story),
          resources: issue.date === dates[0] ? [{ kind: 'article', label: '合成项目占位地址', url: resourceUrl }] : [],
          discussion: rows.map(row => {
            const entry = discussion[row.discussionIndex];
            return { speaker: entry.speaker, time: entry.time.slice(-5), text: entry.text,
              ...(entry.quote ? { quote: { ...entry.quote,
                speaker: row.quoteTarget?.startsWith(issue.date) ? entry.quote.speaker : null } } : {}) };
          }), emphasis: story.emphasis, aiComment: story.aiComment,
        });
      }
    }
  }
  await save(path.join(batch, 'issues.json'), issues);
  const manifest = path.join(runDirectory, 'attachments.json');
  await save(manifest, attachments);
  const final = path.join(runDirectory, 'final');
  await bot('finalize-batch.mjs', ['--directory', batch, '--attachments', manifest, '--out', final]);

  const selectionFile = path.join(runDirectory, 'external-selection.json');
  const external = path.join(runDirectory, 'external-draft.json');
  const enriched = path.join(runDirectory, 'external-with-comments.json');
  await save(selectionFile, selection);
  stage = 'external';
  await bot('generate-external.mjs', [selectionFile, external]);
  stage = 'external-comments';
  await bot('generate-external-comments.mjs', [external, enriched]);
  validateExternalReview(await json(enriched), selection);
  const snapshot = activity(groups);
  validatePublicActivity(snapshot, await json(path.join(final, 'issues.json')));
  await save(path.join(final, 'activity/snapshot.json'), snapshot);
  await save(path.join(final, 'activity/avatar-review.json'), { pending: [], note: 'Synthetic self-drawn square avatars; no real member photos.' });
  for (const rank of [1, 2, 3]) await drawAvatar(path.join(final, 'activity/avatars'), rank);
  await run(path.join(newspaper, 'scripts/prepare-preview.mjs'), ['--date', dates[1], '--batch', final,
    '--external-draft', enriched, '--external-selection', selectionFile], newspaper);
  const validation = await json(path.join(final, 'integration-validation.json'));
  assert.equal(validation.sourceEquality, true);
  assert.equal(validation.activityEquality, true);
  const report = { synthetic: true, runDirectory, finalDirectory: final, previewDirectory: path.join(final, 'preview'),
    dates, model, requests, commands, validation, note: 'Only these new issues are synthetic; newspaper retains its historical public content.' };
  await save(path.join(runDirectory, 'result.json'), report);
  console.log(JSON.stringify({ ...report, commands: commands.map(command => command.script), requests: requests.length }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

// Original pixel art: an inset square on a solid background, with matching editable SVG source.
async function drawAvatar(directory, rank) {
  await mkdir(directory, { recursive: true });
  const colors = [[42, 91, 126], [125, 79, 114], [62, 112, 85]];
  const foreground = colors[rank - 1], background = [245, 239, 224];
  const pixels = Buffer.alloc(32 * (1 + 32 * 3));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const rgb = x >= 5 + rank && x < 27 - rank && y >= 5 + rank && y < 27 - rank ? foreground : background;
    rgb.forEach((byte, channel) => { pixels[y * 97 + 1 + x * 3 + channel] = byte; });
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  await writeFile(path.join(directory, `member-00${rank}.png`), Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]));
  await writeFile(path.join(directory, `member-00${rank}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><title>Synthetic square avatar ${rank}</title><path fill="rgb(${background})" d="M0 0h32v32H0z"/><path fill="rgb(${foreground})" d="M${5 + rank} ${5 + rank}h${22 - 2 * rank}v${22 - 2 * rank}H${5 + rank}z"/></svg>\n`);
}
