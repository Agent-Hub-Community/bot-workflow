// Backfills all locally available WeChat media (images, videos + posters, and downloadable files)
// into published daily editions (newspaper/data/editions/*.json) and weekly editions
// (newspaper/data/weekly-editions/*.json), deduplicated by content MD5 under newspaper/data/attachments/.
// Idempotent: safe to re-run whenever new videos or files are opened in WeChat.
//   WX_ACTIVITY_HOME=/Users/haoqing node "$BOT/scripts/backfill-media.mjs" [--dry-run]
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load, rootDir } from '../lib/newspaper-root.mjs';
import { chatGroups } from '../pipeline/chat-groups.mjs';
import {
  accountImageKey, convertToJpeg, decodeDat, imageFileHash,
  locateFile, locateImage, locateVideo, parseFileMessage,
} from '../pipeline/wechat-images.mjs';

const { validateAttachments } = await load('lib/attachments.mjs');

const dryRun = process.argv.includes('--dry-run');
const home = process.env.WX_ACTIVITY_HOME;
if (!home) throw new Error('Set WX_ACTIVITY_HOME=/Users/haoqing');

const ALLOWED_FILE_EXTS = new Set(['.avif', '.avi', '.doc', '.docx', '.flac', '.gif', '.html', '.jpeg', '.jpg', '.m4a', '.md', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.pdf', '.png', '.ppt', '.pptx', '.txt', '.wav', '.webm', '.webp', '.xlsx', '.zip']);
const IMAGE_MIMES = new Set(['jpg', 'png', 'webp']);
const MAX_MEDIA_BYTES = (Number(process.env.MAX_ATTACHMENT_MB) || 10) * 1024 * 1024;
const md5 = buf => createHash('md5').update(buf).digest('hex');

const cfg = JSON.parse(await readFile(path.join(home, '.wx-cli/config.json'), 'utf8'));
const accountDir = await realpath(path.dirname(cfg.db_dir));
const cache = JSON.parse(await readFile(path.join(home, '.wx-cli/cache/_mtimes.json'), 'utf8'));
const shards = Object.entries(cache).filter(([k]) => /^message\/message_\d+\.db$/.test(k));
const groups = Object.fromEntries((await chatGroups()).map(g => [g.id, g.username]));
const dataDir = path.join(rootDir, 'data');

let imageKey;
const dayCache = new Map();
function queryDayMedia(date, groupId) {
  const cacheKey = `${date}|${groupId}`;
  if (dayCache.has(cacheKey)) return dayCache.get(cacheKey);
  const room = groups[groupId];
  if (!room) { dayCache.set(cacheKey, []); return []; }
  const table = `Msg_${createHash('md5').update(room).digest('hex')}`;
  const start = Date.parse(`${date}T00:00:00+08:00`) / 1000;
  const rows = [];
  for (const [, entry] of shards) {
    const db = new DatabaseSync(entry.path, { readOnly: true });
    try {
      if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) continue;
      rows.push(...db.prepare(`SELECT local_id, create_time, local_type, packed_info_data FROM [${table}] WHERE create_time >= ? AND create_time < ? AND local_type IN (3, 43) ORDER BY create_time, local_id`).all(start, start + 86400));
    } finally { db.close(); }
  }
  dayCache.set(cacheKey, rows);
  return rows;
}

const writtenFiles = new Set();
async function writeBuffer(relative, buffer) {
  if (dryRun || writtenFiles.has(relative)) return;
  const target = path.join(dataDir, relative);
  if (!existsSync(target)) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, buffer);
  }
  writtenFiles.add(relative);
}

async function copyAsset(relative, sourcePath) {
  if (dryRun || writtenFiles.has(relative)) return;
  const target = path.join(dataDir, relative);
  if (!existsSync(target)) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
  }
  writtenFiles.add(relative);
}

const stats = {
  editionsUpdated: 0, weekliesUpdated: 0,
  images: 0, videos: 0, videoPostersOnly: 0, files: 0,
  missingImages: 0, missingVideos: 0, missingFiles: 0,
  uniqueBytes: 0,
};
const countedAssets = new Set();
const countBytes = (rel, bytes) => {
  if (!countedAssets.has(rel)) { countedAssets.add(rel); stats.uniqueBytes += bytes; }
};

async function attachForDiscussion({ dateForMessage, groupId, messages }) {
  // Build per-date-minute queues of image/video DB rows so repeated media at the same minute match in order.
  const queues = new Map();
  const takeRow = (date, kind, hhmm) => {
    const qKey = `${date}|${kind}|${hhmm}`;
    if (!queues.has(qKey)) {
      const rows = queryDayMedia(date, groupId).filter(r =>
        (kind === '[图片]' ? r.local_type === 3 : r.local_type === 43) &&
        new Date((r.create_time + 8 * 3600) * 1000).toISOString().slice(11, 16) === hhmm);
      queues.set(qKey, [...rows]);
    }
    return queues.get(qKey).shift() || null;
  };

  let changed = false;
  for (const message of messages) {
    const text = (message.text || '').trim();
    const resolved = dateForMessage(message.time);
    if (!resolved) continue;
    const { date, hhmm } = resolved;

    if (text === '[图片]') {
      if (message.attachments?.some(a => a.kind === 'image' && a.src)) continue;
      const row = takeRow(date, '[图片]', hhmm);
      const h = row ? imageFileHash(row.packed_info_data) : null;
      const loc = row ? await locateImage(path.join(accountDir, 'msg', 'attach'), groups[groupId], row.create_time, h) : { file: null };
      if (!loc.file) { stats.missingImages++; continue; }
      try {
        const raw = await readFile(loc.file);
        imageKey ??= await accountImageKey(accountDir);
        let { format, data } = decodeDat(raw, imageKey);
        if (!IMAGE_MIMES.has(format)) { data = await convertToJpeg(data, format); format = 'jpg'; }
        const rel = path.posix.join('attachments', 'media', `${md5(data)}.${format}`);
        await writeBuffer(rel, data);
        countBytes(rel, data.length);
        message.attachments = [{ kind: 'image', src: rel, alt: '群聊图片' }];
        validateAttachments(message.attachments);
        stats.images++;
        changed = true;
      } catch {
        stats.missingImages++;
      }
    } else if (text === '[视频]') {
      if (message.attachments?.some(a => a.kind === 'video' && a.src)) continue;
      const row = takeRow(date, '[视频]', hhmm);
      const h = row ? imageFileHash(row.packed_info_data) : null;
      const loc = row ? await locateVideo(path.join(accountDir, 'msg', 'video'), row.create_time, h) : { video: null, poster: null };
      let posterRel;
      if (loc.poster) {
        const pBuf = await readFile(loc.poster);
        posterRel = path.posix.join('attachments', 'media', `${md5(pBuf)}.jpg`);
        await writeBuffer(posterRel, pBuf);
        countBytes(posterRel, pBuf.length);
      }
      if (loc.video) {
        const st = await stat(loc.video);
        if (st.size <= MAX_MEDIA_BYTES) {
          const vBuf = await readFile(loc.video);
          const vRel = path.posix.join('attachments', 'media', `${md5(vBuf)}.mp4`);
          await copyAsset(vRel, loc.video);
          countBytes(vRel, st.size);
          message.attachments = [{ kind: 'video', src: vRel, mime: 'video/mp4', bytes: st.size, ...(posterRel ? { poster: posterRel } : {}) }];
          validateAttachments(message.attachments);
          stats.videos++;
          changed = true;
          continue;
        }
      }
      if (posterRel) {
        message.attachments = [{ kind: 'video', poster: posterRel, label: '视频' }];
        validateAttachments(message.attachments);
        stats.videoPostersOnly++;
        changed = true;
      } else {
        stats.missingVideos++;
      }
    } else if (text.startsWith('[文件]')) {
      const existing = message.attachments?.find(a => a.kind === 'file' && a.href);
      if (existing) {
        if (existing.bytes && existing.bytes > MAX_MEDIA_BYTES) {
          const parsed = parseFileMessage(text);
          message.attachments = [{ kind: 'file', name: existing.name || parsed?.name || '文件', label: parsed?.detail || `${(existing.bytes / 1024 / 1024).toFixed(1)} MB` }];
          stats.skippedOversize = (stats.skippedOversize || 0) + 1;
          changed = true;
        }
        continue;
      }
      const parsed = parseFileMessage(text);
      if (!parsed) continue;
      const ext = path.extname(parsed.name).toLowerCase();
      if (!ALLOWED_FILE_EXTS.has(ext)) continue;
      const ts = Date.parse(`${date}T12:00:00+08:00`) / 1000;
      const loc = await locateFile(path.join(accountDir, 'msg', 'file'), ts, parsed.name, parsed.md5, { maxBytes: MAX_MEDIA_BYTES });
      if (!loc.file) { stats.missingFiles++; continue; }
      const rel = path.posix.join('attachments', 'files', `${loc.md5}${ext}`);
      await copyAsset(rel, loc.file);
      countBytes(rel, loc.bytes);
      message.attachments = [{ kind: 'file', href: rel, name: parsed.name, bytes: loc.bytes }];
      validateAttachments(message.attachments);
      stats.files++;
      changed = true;
    }
  }
  return changed;
}

// 1. Backfill all daily editions
const edDir = path.join(dataDir, 'editions');
for (const file of (await readdir(edDir)).filter(f => f.endsWith('.json')).sort()) {
  const full = path.join(edDir, file);
  const ed = JSON.parse(await readFile(full, 'utf8'));
  let updated = false;
  for (const page of ed.pages || []) {
    if (!groups[page.id]) continue;
    for (const story of page.stories || []) {
      if (!story.discussion?.length) continue;
      if (await attachForDiscussion({
        dateForMessage: time => ({ date: ed.date, hhmm: time.slice(0, 5) }),
        groupId: page.id,
        messages: story.discussion,
      })) updated = true;
    }
  }
  if (updated) {
    stats.editionsUpdated++;
    if (!dryRun) await writeFile(full, JSON.stringify(ed, null, 2) + '\n');
  }
}

// 2. Backfill all weekly editions (times are "MM.DD HH:MM")
const wkDir = path.join(dataDir, 'weekly-editions');
if (existsSync(wkDir)) {
  for (const file of (await readdir(wkDir)).filter(f => f.endsWith('.json')).sort()) {
    const full = path.join(wkDir, file);
    const wk = JSON.parse(await readFile(full, 'utf8'));
    const year = (wk.from || wk.start || file).slice(0, 4);
    let updated = false;
    for (const page of wk.pages || []) {
      if (!groups[page.id]) continue;
      for (const story of page.stories || []) {
        if (!story.discussion?.length) continue;
        if (await attachForDiscussion({
          dateForMessage: time => {
            const m = /^(\d{2})\.(\d{2})\s+(\d{2}:\d{2})$/.exec(time || '');
            return m ? { date: `${year}-${m[1]}-${m[2]}`, hhmm: m[3] } : null;
          },
          groupId: page.id,
          messages: story.discussion,
        })) updated = true;
      }
    }
    if (updated) {
      stats.weekliesUpdated++;
      if (!dryRun) await writeFile(full, JSON.stringify(wk, null, 2) + '\n');
    }
  }
}

// 3. Prune any unreferenced files under data/attachments/ (only selected discussion/story attachments stay).
const referenced = new Set();
const collectRefs = pages => {
  for (const page of pages || []) for (const story of page.stories || []) {
    for (const a of [...(story.attachments || []), ...(story.discussion || []).flatMap(m => m.attachments || [])]) {
      for (const f of [a.src, a.href, a.poster]) if (typeof f === 'string' && f.startsWith('attachments/')) referenced.add(f);
    }
  }
};
for (const file of (await readdir(edDir)).filter(f => f.endsWith('.json'))) {
  collectRefs(JSON.parse(await readFile(path.join(edDir, file), 'utf8')).pages);
}
if (existsSync(wkDir)) {
  for (const file of (await readdir(wkDir)).filter(f => f.endsWith('.json'))) {
    collectRefs(JSON.parse(await readFile(path.join(wkDir, file), 'utf8')).pages);
  }
}
let pruned = 0;
for (const sub of ['media', 'files']) {
  const dir = path.join(dataDir, 'attachments', sub);
  if (!existsSync(dir)) continue;
  for (const name of await readdir(dir)) {
    const rel = path.posix.join('attachments', sub, name);
    if (!referenced.has(rel)) {
      if (!dryRun) await unlink(path.join(dir, name));
      pruned++;
    }
  }
}

console.log(JSON.stringify({ ...stats, pruned, referencedFiles: referenced.size, maxMB: MAX_MEDIA_BYTES / 1024 / 1024, dryRun }, null, 2));
