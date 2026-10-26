import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectImages } from '../collect-images.mjs';
import { joinGroups } from '../chat-groups.mjs';
import { chatrooms } from '../groups.example.mjs';
import { load } from '../../lib/newspaper-root.mjs';
import { llmModel } from '../../lib/llm.mjs';
import { deriveImageKey } from '../wechat-images.mjs';
import { encodeDat, fakeAccount, jpeg, md5 } from './dat-fixture.mjs';

const { modelInput } = await load('lib/image-messages.mjs');
const { validateStoryDiscussion } = await load('lib/story-discussion.mjs');
// Template placeholders stand in for the private chatroom usernames.
const groups = joinGroups(chatrooms);
const username = groups.find(group => group.id === 'group-1').username, date = '2026-10-15';
const at = clock => Date.parse(`${date}T${clock}:00+08:00`) / 1000;
// One opened image (HD copy on disk), one only fetched as a thumbnail, one whose file never arrived.
const messages = [
  { local_id: 10, clock: '15:40', type: '文本', content: '这个榜单有点意思' },
  { local_id: 11, clock: '15:41', type: '图片', file: '_h', hash: 'a'.repeat(32) },
  { local_id: 12, clock: '15:42', type: '图片', file: '_t', hash: 'b'.repeat(32) },
  { local_id: 13, clock: '15:43', type: '图片', hash: 'c'.repeat(32) },
  { local_id: 14, clock: '15:44', type: '文本', content: '第二张看不清' },
];

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'collect-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uin = '123456789', accountDir = await fakeAccount(root, { uin });
  const key = deriveImageKey(uin, 'wxid_demo');
  const home = path.join(root, 'home'), cacheDir = path.join(home, '.wx-cli', 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(home, '.wx-cli', 'config.json'), JSON.stringify({ db_dir: path.join(accountDir, 'db_storage') }));
  const shard = path.join(cacheDir, 'message_0.db');
  await writeFile(path.join(cacheDir, '_mtimes.json'), JSON.stringify({ 'message/message_0.db': { path: shard } }));
  const db = new DatabaseSync(shard);
  db.exec(`CREATE TABLE [Msg_${md5(username)}] (local_id INTEGER, create_time INTEGER, packed_info_data BLOB)`);
  const insert = db.prepare(`INSERT INTO [Msg_${md5(username)}] VALUES (?, ?, ?)`);

  const images = new Map();
  for (const m of messages) {
    insert.run(m.local_id, at(m.clock), m.hash ? Buffer.concat([Buffer.from('0808100b1a22', 'hex'), Buffer.from(m.hash)]) : null);
    if (!m.file) continue;
    const time = new Date(at(m.clock) * 1000);
    const dir = path.join(accountDir, 'msg', 'attach', md5(username),
      `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}`, 'Img');
    await mkdir(dir, { recursive: true });
    const image = jpeg(m.file === '_h' ? 6000 : 900);
    images.set(m.local_id, image);
    await writeFile(path.join(dir, `${m.hash}${m.file}.dat`), encodeDat(image, key));
  }
  db.close();

  const dayDir = path.join(root, 'batch', date);
  await mkdir(dayDir, { recursive: true });
  const raw = messages.map(m => ({ local_id: m.local_id, timestamp: at(m.clock), time: `${date} ${m.clock}`,
    sender: `member-${m.local_id % 2}`, type: m.type, content: m.content ?? `[图片] local_id=${m.local_id}` }));
  const input = { group: { id: 'group-1', label: '一群' }, date, coverage: { count: raw.length },
    messages: raw.map((m, i) => ({ id: `m${String(i + 1).padStart(4, '0')}`, time: m.time,
      speaker: `p${m.local_id % 2 + 1}`, type: m.type, content: m.content.replace(/ local_id=\d+/, '') })) };
  await writeFile(path.join(dayDir, 'group-1.raw.json'), JSON.stringify(raw));
  await writeFile(path.join(dayDir, 'group-1.input.json'), JSON.stringify(input));
  return { dayDir, images, run: options => collectImages(date, path.join(root, 'batch'), {
    home, cacheDir: path.join(root, 'descriptions'), log: () => {}, groups, ...options }) };
}

// Stands in for the gateway: checks what one image request carries and answers with a description.
function stubModel(answer) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    const [text, image] = body.messages[1].content;
    calls.push({ body, text: text.text, image: Buffer.from(image.image_url.url.split(',')[1], 'base64') });
    const reply = answer(calls.at(-1));
    if (reply.status) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: reply.status });
    return Response.json({ model: llmModel, choices: [{ finish_reason: 'stop',
      message: { content: `\`\`\`json\n${JSON.stringify({ description: reply.description })}\n\`\`\`` } }] });
  };
  return { calls, fetchImpl };
}

test('collect-images stores decoded images privately and gives descriptions only to the draft model', async t => {
  const { dayDir, images, run } = await fixture(t);
  // The thumbnail request fails the first time, as a gateway error would.
  const first = stubModel(call => call.text.startsWith('这张图是缩略图') ? { status: 503 }
    : { description: '排行榜截图，标题「Agent Arena」，作者 @owner_x，详见 https://example.com/board 或 owner@example.com' });
  const result = await run({ fetchImpl: first.fetchImpl });

  assert.equal(first.calls.length, 2);
  const original = first.calls.find(call => call.text.startsWith('这张图是原图'));
  assert.ok(original.image.equals(images.get(11)), 'the model sees the decrypted image bytes');
  assert.equal(original.body.model, llmModel);
  assert.ok(original.body.max_tokens >= 2000);
  assert.match(original.text, /→ 15:41 p2：\[图片\]/);
  assert.match(original.text, /15:40 p1：这个榜单有点意思/);
  assert.deepEqual(result.failures.map(f => [f.id, f.error.split(':')[0]]), [['m0003', 'describe']]);

  const stored = JSON.parse(await readFile(path.join(dayDir, 'group-1.input.json'), 'utf8'));
  assert.deepEqual(stored.messages.map(m => m.content), ['这个榜单有点意思', '[图片]', '[图片]', '[图片]', '第二张看不清']);
  assert.deepEqual(stored.messages.map(m => m.image?.quality), [undefined, 'original', 'thumbnail', 'missing', undefined]);
  assert.equal(stored.messages[1].image.description, '排行榜截图，标题「Agent Arena」，作者 @[账号]，详见 [链接] 或 [联系方式已隐藏]');
  assert.deepEqual(stored.coverage.images, { total: 3, original: 1, thumbnail: 1, missing: 1, described: 1 });

  const media = path.join(dayDir, 'media', 'group-1');
  assert.deepEqual((await readdir(media)).sort(), ['m0002.jpg', 'm0003.jpg']);
  assert.ok((await readFile(path.join(media, 'm0002.jpg'))).equals(images.get(11)));
  for (const dir of [path.join(dayDir, 'media'), media]) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const file of ['m0002.jpg', 'm0003.jpg']) assert.equal((await stat(path.join(media, file))).mode & 0o777, 0o600);
  for (const file of ['group-1.input.json', 'group-1.images.json']) assert.equal((await stat(path.join(dayDir, file))).mode & 0o777, 0o600);

  // A rerun asks only about the failed image; the described one comes from the md5 cache.
  const second = stubModel(() => ({ description: '缩略图，能认出一张表格，文字看不清' }));
  assert.deepEqual((await run({ fetchImpl: second.fetchImpl })).failures, []);
  assert.equal(second.calls.length, 1);
  assert.ok(second.calls[0].image.equals(images.get(12)));
  const final = JSON.parse(await readFile(path.join(dayDir, 'group-1.input.json'), 'utf8'));
  assert.deepEqual(final.coverage.images, { total: 3, original: 1, thumbnail: 1, missing: 1, described: 2 });
  assert.deepEqual(modelInput(final).messages.slice(1, 4).map(m => m.content), [
    '[图片（原图）：排行榜截图，标题「Agent Arena」，作者 @[账号]，详见 [链接] 或 [联系方式已隐藏]]',
    '[图片（缩略图）：缩略图，能认出一张表格，文字看不清]',
    '[图片（未取到）]',
  ]);

  // Batch discussion scripts copy message.content of the stored input into the reader panel.
  const discussion = final.messages.map((m, i) => ({ speaker: i % 2 + 1, time: m.time.slice(11), text: m.content }));
  validateStoryDiscussion(discussion);
  assert.deepEqual(discussion.slice(1, 4).map(m => m.text), ['[图片]', '[图片]', '[图片]']);
  assert.ok(!JSON.stringify(discussion).includes('Agent Arena'));
});

test('collect-images refuses an input whose messages no longer match the raw export', async t => {
  const { dayDir, run } = await fixture(t);
  const input = JSON.parse(await readFile(path.join(dayDir, 'group-1.input.json'), 'utf8'));
  input.messages.pop();
  await writeFile(path.join(dayDir, 'group-1.input.json'), JSON.stringify(input));
  await assert.rejects(run({ fetchImpl: () => assert.fail('no request expected') }), /do not line up/);
});
