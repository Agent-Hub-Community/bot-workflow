// Reads the image messages of one collected day. For each group it finds the image file the WeChat
// client stored (the full image once the client has shown it, otherwise the thumbnail fetched on receipt),
// decodes it into the private batch, asks the image model for an objective description, and records
// quality and description on the group input. message.content stays "[图片]"; see the newspaper's lib/image-messages.mjs.
// Run after collect-daily.mjs, and again whenever collect-daily.mjs rewrites the input:
//   WX_ACTIVITY_HOME=... DAILY_LLM_API_KEY=... node "$PIPELINE/collect-images.mjs" YYYY-MM-DD BATCH_DIR
// Descriptions are cached by image md5 in scratch/image-descriptions/ of the newspaper checkout, so a rerun only
// asks the model about failed or newly opened images.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { llmHeaders, llmModel, llmUrl } from '../lib/llm.mjs';
import { load, rootDir } from '../lib/newspaper-root.mjs';
import { chatGroups } from './chat-groups.mjs';
import { accountImageKey, convertToJpeg, decodeDat, imageFileHash, locateImage } from './wechat-images.mjs';

const { cleanText } = await load('lib/content.mjs');
const { imageCoverage } = await load('lib/image-messages.mjs');
const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const qualityNames = { original: '原图', thumbnail: '缩略图' };
const hash = (algorithm, data) => createHash(algorithm).update(data).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = file => access(file).then(() => true, () => false);
async function save(file, data) {
  await writeFile(file, Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
// The prompt already forbids these; the replacements catch what the model copies anyway.
// cleanText runs first so that e-mail addresses are hidden whole before @handles are.
const cleanDescription = text => cleanText(text)
  .replace(/https?:\/\/\S+/g, '[链接]')
  .replace(/\bwxid_[A-Za-z0-9_]+/g, '[成员]')
  .replace(/@[A-Za-z0-9_]{2,}/g, '@[账号]')
  .replace(/\s+/g, ' ').trim();

function imageHashes(home, cache, username, rows) {
  const table = `Msg_${hash('md5', username)}`;
  const shards = Object.entries(cache).filter(([name]) => /^message\/message_\d+\.db$/.test(name));
  const found = new Map();
  for (const [, entry] of shards) {
    const db = new DatabaseSync(entry.path, { readOnly: true });
    try {
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) continue;
      const query = db.prepare(`SELECT packed_info_data AS packed FROM [${table}] WHERE local_id = ? AND create_time = ?`);
      for (const row of rows) {
        const hit = query.get(row.local_id, row.timestamp);
        if (hit && !found.has(row.local_id)) found.set(row.local_id, imageFileHash(hit.packed));
      }
    } finally { db.close(); }
  }
  const absent = rows.filter(row => !found.has(row.local_id));
  if (absent.length) throw new Error(`${absent.length} image messages are not in the wx cache under ${home}; rerun collect-daily.mjs first`);
  return found;
}

export async function collectImages(date, batch, {
  home = process.env.WX_ACTIVITY_HOME,
  cacheDir = path.join(rootDir, 'scratch/image-descriptions'),
  fetchImpl = fetch, concurrency = 4, contextSize = 3, log = console.log, groups,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !batch) throw new Error('Usage: collect-images.mjs YYYY-MM-DD BATCH_DIR');
  if (!home) throw new Error('Set WX_ACTIVITY_HOME to the verified AgentHub account home.');
  const chatrooms = Object.fromEntries((groups ?? await chatGroups()).map(group => [group.id, group.username]));
  const dayDir = path.resolve(batch, date);
  const prompt = await readFile(new URL('../prompts/image-description.md', import.meta.url), 'utf8');
  const accountDir = await realpath(path.dirname((await read(path.join(home, '.wx-cli/config.json'))).db_dir));
  const cache = await read(path.join(home, '.wx-cli/cache/_mtimes.json'));
  let key;
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700);

  const pages = [];
  for (const [group, username] of Object.entries(chatrooms)) {
    const inputFile = path.join(dayDir, `${group}.input.json`);
    if (!await exists(inputFile)) continue;
    const input = await read(inputFile), raw = await read(path.join(dayDir, `${group}.raw.json`));
    if (input.group?.id !== group || input.date !== date) throw new Error(`${group}: input belongs to ${input.group?.id} ${input.date}`);
    // collect-daily writes both files in the same order; the input only renames speakers and cleans text.
    if (raw.length !== input.messages.length || raw.some((m, i) => m.type !== input.messages[i].type || m.time !== input.messages[i].time)) {
      throw new Error(`${group}: raw and input messages do not line up`);
    }
    const indexes = raw.flatMap((m, i) => m.type === '图片' ? [i] : []);
    const hashes = indexes.length ? imageHashes(home, cache, username, indexes.map(i => raw[i])) : new Map();
    const mediaDir = path.join(dayDir, 'media', group);
    // A rerun may find a larger copy in another format; old files of this group must not linger.
    await rm(mediaDir, { recursive: true, force: true });
    const records = [];
    for (const i of indexes) {
      const { id, time } = input.messages[i];
      const record = { id, local_id: raw[i].local_id, time, quality: 'missing' };
      records.push(record);
      const located = await locateImage(path.join(accountDir, 'msg', 'attach'), username, raw[i].timestamp, hashes.get(raw[i].local_id));
      if (!located.file) continue;
      try {
        const data = await readFile(located.file);
        key ??= await accountImageKey(accountDir);
        let { format, data: image } = decodeDat(data, key);
        if (!mimeTypes[format]) { image = await convertToJpeg(image, format); format = 'jpg'; }
        await mkdir(mediaDir, { recursive: true, mode: 0o700 });
        await chmod(path.join(dayDir, 'media'), 0o700);
        await chmod(mediaDir, 0o700);
        const file = path.join(mediaDir, `${id}.${format}`);
        await save(file, image);
        Object.assign(record, { quality: located.quality, source: path.basename(located.file).replace(/^[0-9a-f]{32}/, ''),
          format, bytes: image.length, md5: hash('md5', image), file: path.relative(dayDir, file) });
      } catch (error) {
        record.error = `decode: ${error.message}`;
      }
    }
    pages.push({ group, inputFile, input, records });
  }

  const jobs = pages.flatMap(page => page.records.filter(record => record.file).map(record => ({ page, record })));
  async function describe({ page, record }) {
    const cacheFile = path.join(cacheDir, `${record.md5}.json`);
    const cached = await read(cacheFile).catch(() => null);
    if (cached?.description) {
      record.description = cached.description;
      return;
    }
    const at = page.input.messages.findIndex(m => m.id === record.id);
    const context = page.input.messages.slice(Math.max(0, at - contextSize), at + contextSize + 1).map(m =>
      `${m.id === record.id ? '→ ' : ''}${m.time.slice(11)} ${m.speaker ?? '系统'}：${m.content.slice(0, 300)}`).join('\n');
    const image = await readFile(path.join(dayDir, record.file));
    const response = await fetchImpl(llmUrl, {
      method: 'POST', headers: llmHeaders(), signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model: llmModel, max_tokens: 4096, stream: false,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: [
          { type: 'text', text: `这张图是${qualityNames[record.quality]}。箭头标出的是这张图，前后群消息：\n${context}` },
          { type: 'image_url', image_url: { url: `data:${mimeTypes[record.format]};base64,${image.toString('base64')}` } },
        ] }],
      }),
    });
    const result = await response.json().catch(() => null);
    const choice = result?.choices?.[0];
    if (!response.ok || result?.model !== llmModel || choice?.finish_reason !== 'stop' || !choice.message?.content) {
      throw new Error(`image model: ${JSON.stringify({ http: response.status, model: result?.model, finish: choice?.finish_reason, error: result?.error })}`);
    }
    const parsed = JSON.parse(choice.message.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (typeof parsed?.description !== 'string') throw new Error('image model returned no description field');
    record.description = cleanDescription(parsed.description);
    await save(cacheFile, { model: llmModel, description: record.description, describedAt: new Date().toISOString() });
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (jobs.length) {
      const job = jobs.shift();
      try { await describe(job); } catch (error) { job.record.error = `describe: ${error.message}`; }
    }
  }));

  const failures = [];
  for (const { group, inputFile, input, records } of pages) {
    for (const record of records) {
      const message = input.messages.find(m => m.id === record.id);
      message.image = { quality: record.quality, ...(record.description ? { description: record.description } : {}) };
      if (record.error) failures.push({ group, id: record.id, error: record.error });
    }
    input.coverage.images = imageCoverage(records);
    await save(inputFile, input);
    await save(path.join(path.dirname(inputFile), `${group}.images.json`), records);
    log(JSON.stringify({ group, images: input.coverage.images }));
  }
  return { pages: pages.map(({ group, records }) => ({ group, records })), failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { failures } = await collectImages(process.argv[2], process.argv[3]);
  if (failures.length) {
    console.error(JSON.stringify({ failures }, null, 2));
    process.exitCode = 1;
  }
}
