// Compresses all existing newspaper media attachments (images -> WebP + width/height, videos -> H.264 CRF 28 + faststart)
// and updates references in data/editions/*.json and data/weekly-editions/*.json.
//   NEWSPAPER_DIR=/path/to/newspaper node scripts/optimize-media.mjs
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeImageFile, optimizeVideoFile } from '../pipeline/media-optimize.mjs';

const CONCURRENCY = 6;
const MEDIA_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const newspaperRoot = path.resolve(process.env.NEWSPAPER_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../newspaper'));

async function runPool(items, worker, limit = CONCURRENCY) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]);
    }
  }));
  return results;
}

const dataDir = path.join(newspaperRoot, 'data');
const mediaDir = path.join(dataDir, 'attachments', 'media');
const files = (await readdir(mediaDir)).sort();

const images = files.filter(f => MEDIA_IMAGE_EXTS.has(path.extname(f).toLowerCase()));
const videos = files.filter(f => path.extname(f).toLowerCase() === '.mp4');

let origImgBytes = 0, newImgBytes = 0, imgConverted = 0;
const relMap = new Map(); // oldRel -> { rel, bytes, width, height, mime }

const imgResults = await runPool(images, async name => {
  const full = path.join(mediaDir, name);
  const oldRel = `attachments/media/${name}`;
  const res = await optimizeImageFile(full, { maxDimension: 1440, quality: 80 });
  const newRel = `attachments/media/${path.basename(res.file)}`;
  return { oldRel, newRel, ...res };
});

for (const res of imgResults) {
  origImgBytes += res.origBytes;
  newImgBytes += res.bytes;
  if (res.changed) imgConverted++;
  relMap.set(res.oldRel, {
    rel: res.newRel, bytes: res.bytes, width: res.width, height: res.height, mime: res.mime,
  });
}

let origVidBytes = 0, newVidBytes = 0, vidOptimized = 0;
const vidMap = new Map();
const vidResults = await runPool(videos, async name => {
  const full = path.join(mediaDir, name);
  const rel = `attachments/media/${name}`;
  const res = await optimizeVideoFile(full, { maxWidth: 960, crf: 28 });
  return { rel, ...res };
}, 3);

for (const res of vidResults) {
  origVidBytes += res.origBytes;
  newVidBytes += res.bytes;
  if (res.changed) vidOptimized++;
  vidMap.set(res.rel, { bytes: res.bytes });
}

function patchAttachment(att) {
  let dirty = false;
  if (att.src && relMap.has(att.src)) {
    const info = relMap.get(att.src);
    if (att.src !== info.rel) { att.src = info.rel; dirty = true; }
    if (att.kind === 'image') {
      if (att.mime && att.mime !== info.mime) { att.mime = info.mime; dirty = true; }
      if (att.bytes !== undefined && att.bytes !== info.bytes) { att.bytes = info.bytes; dirty = true; }
      if (info.width && info.height && (att.width !== info.width || att.height !== info.height)) {
        att.width = info.width;
        att.height = info.height;
        dirty = true;
      }
    }
  }
  if (att.src && vidMap.has(att.src)) {
    const info = vidMap.get(att.src);
    if (att.bytes !== undefined && att.bytes !== info.bytes) { att.bytes = info.bytes; dirty = true; }
  }
  if (att.poster && relMap.has(att.poster)) {
    const info = relMap.get(att.poster);
    if (att.poster !== info.rel) { att.poster = info.rel; dirty = true; }
  }
  return dirty;
}

let updatedEditions = 0;
for (const dirName of ['editions', 'weekly-editions']) {
  const dir = path.join(dataDir, dirName);
  const names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const edition = JSON.parse(await readFile(file, 'utf8'));
    let dirty = false;
    for (const page of edition.pages || []) {
      for (const story of page.stories || []) {
        for (const att of story.attachments || []) if (patchAttachment(att)) dirty = true;
        for (const msg of story.discussion || []) {
          for (const att of msg.attachments || []) if (patchAttachment(att)) dirty = true;
        }
      }
    }
    if (dirty) {
      await writeFile(file, `${JSON.stringify(edition, null, 2)}\n`);
      updatedEditions++;
    }
  }
}

// Compute final media directory total
const finalFiles = await readdir(mediaDir);
let finalBytes = 0;
for (const f of finalFiles) finalBytes += (await stat(path.join(mediaDir, f))).size;

const mb = b => `${(b / 1048576).toFixed(2)} MB`;
console.log(JSON.stringify({
  images: { count: images.length, converted: imgConverted, before: mb(origImgBytes), after: mb(newImgBytes), savedPct: Math.round((1 - newImgBytes / (origImgBytes || 1)) * 100) },
  videos: { count: videos.length, optimized: vidOptimized, before: mb(origVidBytes), after: mb(newVidBytes), savedPct: Math.round((1 - newVidBytes / (origVidBytes || 1)) * 100) },
  mediaTotalAfter: mb(finalBytes),
  updatedEditions,
}, null, 2));
