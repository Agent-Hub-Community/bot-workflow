// Extracts all locally available WeChat media (images, videos + posters, and downloadable files)
// of one collected day into BATCH/<date>/media/<group>/ without calling any external model API.
// Antigravity subagents read decoded images directly via read_file; package-daily.mjs mounts all
// collected media into BATCH/attachments/ with content-hash deduplication.
//   WX_ACTIVITY_HOME=... node "$PIPELINE/collect-images.mjs" YYYY-MM-DD BATCH_DIR
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { access, chmod, copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from '../lib/newspaper-root.mjs';
import { chatGroups } from './chat-groups.mjs';
import {
  accountImageKey, convertToJpeg, decodeDat, imageFileHash,
  locateFile, locateImage, locateVideo, parseFileMessage,
} from './wechat-images.mjs';
import { optimizeImageFile, optimizeVideoFile } from './media-optimize.mjs';

const { imageCoverage } = await load('lib/image-messages.mjs');
const mimeTypes = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const ALLOWED_FILE_EXTS = new Set(['.avif', '.avi', '.doc', '.docx', '.flac', '.gif', '.html', '.jpeg', '.jpg', '.m4a', '.md', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.pdf', '.png', '.ppt', '.pptx', '.txt', '.wav', '.webm', '.webp', '.xlsx', '.zip']);
const MAX_MEDIA_BYTES = (Number(process.env.MAX_ATTACHMENT_MB) || 10) * 1024 * 1024;
const hash = (algorithm, data) => createHash(algorithm).update(data).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = file => access(file).then(() => true, () => false);

async function save(file, data) {
  await writeFile(file, Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function mediaHashes(home, cache, username, rows) {
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
  const absent = rows.filter(row => row.type === '图片' && !found.has(row.local_id));
  if (absent.length) throw new Error(`${absent.length} image messages are not in the wx cache under ${home}; rerun collect-daily.mjs first`);
  return found;
}

export async function collectImages(date, batch, {
  home = process.env.WX_ACTIVITY_HOME,
  log = console.log,
  groups,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !batch) throw new Error('Usage: collect-images.mjs YYYY-MM-DD BATCH_DIR');
  if (!home) throw new Error('Set WX_ACTIVITY_HOME to the verified AgentHub account home.');
  const chatrooms = Object.fromEntries((groups ?? await chatGroups()).map(group => [group.id, group.username]));
  const dayDir = path.resolve(batch, date);
  const accountDir = await realpath(path.dirname((await read(path.join(home, '.wx-cli/config.json'))).db_dir));
  const cache = await read(path.join(home, '.wx-cli/cache/_mtimes.json'));
  let key;

  const pages = [];
  const failures = [];
  for (const [group, username] of Object.entries(chatrooms)) {
    const inputFile = path.join(dayDir, `${group}.input.json`);
    if (!await exists(inputFile)) continue;
    const input = await read(inputFile), raw = await read(path.join(dayDir, `${group}.raw.json`));
    if (input.group?.id !== group || input.date !== date) throw new Error(`${group}: input belongs to ${input.group?.id} ${input.date}`);
    if (raw.length !== input.messages.length || raw.some((m, i) => m.type !== input.messages[i].type || m.time !== input.messages[i].time)) {
      throw new Error(`${group}: raw and input messages do not line up`);
    }

    const imageOrVideoIndexes = raw.flatMap((m, i) => (m.type === '图片' || m.type === '视频') ? [i] : []);
    const hashes = imageOrVideoIndexes.length ? mediaHashes(home, cache, username, imageOrVideoIndexes.map(i => raw[i])) : new Map();
    const mediaDir = path.join(dayDir, 'media', group);
    await rm(mediaDir, { recursive: true, force: true });
    const ensureMediaDir = async () => {
      await mkdir(mediaDir, { recursive: true, mode: 0o700 });
      await chmod(path.join(dayDir, 'media'), 0o700);
      await chmod(mediaDir, 0o700);
    };

    const imageRecords = [];
    const mediaRecords = [];
    for (let i = 0; i < raw.length; i++) {
      const m = raw[i];
      const { id, time } = input.messages[i];

      if (m.type === '图片') {
        const record = { id, kind: 'image', local_id: m.local_id, time, quality: 'missing' };
        imageRecords.push(record);
        mediaRecords.push(record);
        const located = await locateImage(path.join(accountDir, 'msg', 'attach'), username, m.timestamp, hashes.get(m.local_id));
        if (!located.file) continue;
        try {
          const data = await readFile(located.file);
          key ??= await accountImageKey(accountDir);
          let { format, data: image } = decodeDat(data, key);
          if (!mimeTypes[format]) { image = await convertToJpeg(image, format); format = 'jpg'; }
          await ensureMediaDir();
          const rawFile = path.join(mediaDir, `${id}.${format}`);
          await save(rawFile, image);
          const opt = await optimizeImageFile(rawFile, { maxDimension: 1440, quality: 80 });
          await chmod(opt.file, 0o600);
          const finalBytes = await readFile(opt.file);
          format = opt.ext.slice(1);
          Object.assign(record, {
            quality: located.quality,
            source: path.basename(located.file).replace(/^[0-9a-f]{32}/, ''),
            format, bytes: finalBytes.length, md5: hash('md5', finalBytes), file: path.relative(dayDir, opt.file),
            ...(opt.width && opt.height ? { width: opt.width, height: opt.height } : {}),
          });
        } catch (error) {
          record.error = `decode: ${error.message}`;
          failures.push({ group, id, error: record.error });
        }
      } else if (m.type === '视频') {
        const record = { id, kind: 'video', local_id: m.local_id, time };
        mediaRecords.push(record);
        const located = await locateVideo(path.join(accountDir, 'msg', 'video'), m.timestamp, hashes.get(m.local_id));
        if (located.video) {
          const st = await stat(located.video).catch(() => null);
          if (st && st.size <= MAX_MEDIA_BYTES) {
            await ensureMediaDir();
            const dest = path.join(mediaDir, `${id}.mp4`);
            await copyFile(located.video, dest);
            await optimizeVideoFile(dest, { maxWidth: 960, crf: 28 });
            await chmod(dest, 0o600);
            const data = await readFile(dest);
            Object.assign(record, { format: 'mp4', bytes: data.length, md5: hash('md5', data), file: path.relative(dayDir, dest) });
          }
        }
        if (located.poster) {
          await ensureMediaDir();
          const rawPoster = path.join(mediaDir, `${id}.poster.jpg`);
          await copyFile(located.poster, rawPoster);
          const optPoster = await optimizeImageFile(rawPoster, { maxDimension: 1440, quality: 80 });
          await chmod(optPoster.file, 0o600);
          const data = await readFile(optPoster.file);
          Object.assign(record, { poster: path.relative(dayDir, optPoster.file), posterFormat: optPoster.ext.slice(1), posterMd5: hash('md5', data) });
        }
      } else if (String(m.content || '').trim().startsWith('[文件]')) {
        const parsed = parseFileMessage(m.content);
        if (!parsed) continue;
        const ext = path.extname(parsed.name).toLowerCase();
        const record = { id, kind: 'file', local_id: m.local_id, time, name: parsed.name, detail: parsed.detail };
        mediaRecords.push(record);
        if (!ALLOWED_FILE_EXTS.has(ext)) continue;
        const located = await locateFile(path.join(accountDir, 'msg', 'file'), m.timestamp, parsed.name, parsed.md5, { maxBytes: MAX_MEDIA_BYTES });
        if (located.file) {
          await ensureMediaDir();
          const dest = path.join(mediaDir, `${id}${ext}`);
          await copyFile(located.file, dest);
          await chmod(dest, 0o600);
          Object.assign(record, { format: ext.slice(1), bytes: located.bytes, md5: located.md5, file: path.relative(dayDir, dest) });
        }
      }
    }

    for (const record of imageRecords) {
      const message = input.messages.find(m => m.id === record.id);
      message.image = { quality: record.quality, ...(record.file ? { file: record.file } : {}) };
    }
    input.coverage.images = imageCoverage(imageRecords);
    await save(inputFile, input);
    await save(path.join(dayDir, `${group}.images.json`), imageRecords);
    await save(path.join(dayDir, `${group}.media.json`), mediaRecords);
    const videos = mediaRecords.filter(r => r.kind === 'video' && (r.file || r.poster)).length;
    const files = mediaRecords.filter(r => r.kind === 'file' && r.file).length;
    log(JSON.stringify({ group, images: input.coverage.images, videos, files }));
    pages.push({ group, records: imageRecords, media: mediaRecords });
  }
  return { pages, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { failures } = await collectImages(process.argv[2], process.argv[3]);
  if (failures.length) {
    console.error(JSON.stringify({ failures }, null, 2));
    process.exitCode = 1;
  }
}
