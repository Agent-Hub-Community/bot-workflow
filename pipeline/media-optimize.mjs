// Media optimizer for Agent Hub attachments:
// - Converts JPEG/PNG images to WebP (cwebp -q 80 -m 4, max 1440px edge) with natural width/height extraction.
// - Re-encodes MP4 videos with H.264 CRF 28 + max 960px width + moov faststart for instant streaming playback.
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

// Pure-Node image header reader for PNG, JPEG, and WebP (avoids spawning a subprocess per image).
export function readImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG: 8-byte signature + IHDR chunk (width at 16..20, height at 20..24)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // WebP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
  }
  // JPEG: scan SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15 markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    let orientation = 1;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      while (offset < buf.length && buf[offset] === 0xff) offset++;
      if (offset >= buf.length) break;
      const marker = buf[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > buf.length) break;
      const len = buf.readUInt16BE(offset);
      if (len < 2 || offset + len > buf.length) break;
      // Check EXIF orientation in APP1 so portrait phone photos report post-rotation dimensions.
      if (marker === 0xe1 && len > 16 && buf.subarray(offset + 2, offset + 8).toString('ascii') === 'Exif\0\0') {
        const tiff = offset + 8;
        const le = buf.subarray(tiff, tiff + 2).toString('ascii') === 'II';
        const read16 = p => le ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
        const read32 = p => le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        const ifd0 = tiff + read32(tiff + 4);
        if (ifd0 + 2 <= offset + len) {
          const count = read16(ifd0);
          for (let i = 0; i < count; i++) {
            const entry = ifd0 + 2 + i * 12;
            if (entry + 12 > offset + len) break;
            if (read16(entry) === 0x0112) { orientation = read16(entry + 8); break; }
          }
        }
      }
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
        }
      }
      offset += len;
    }
  }
  return null;
}

let toolsCache = null;
async function hasTool(name) {
  toolsCache ??= new Map();
  if (toolsCache.has(name)) return toolsCache.get(name);
  try {
    await execFile('which', [name]);
    toolsCache.set(name, true);
    return true;
  } catch {
    toolsCache.set(name, false);
    return false;
  }
}

export async function probeDimensions(filePath) {
  try {
    const buf = await readFile(filePath);
    const dims = readImageDimensions(buf);
    if (dims) return dims;
  } catch { /* fall through */ }
  if (!await hasTool('ffprobe')) return null;
  try {
    const { stdout } = await execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath,
    ]);
    const m = /(\d+)x(\d+)/.exec(stdout.trim());
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  } catch { return null; }
}

const MIME_BY_EXT = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };

export async function optimizeImageFile(filePath, { maxDimension = 1440, quality = 80 } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const origBuf = await readFile(filePath);
  const origBytes = origBuf.length;
  const origDims = readImageDimensions(origBuf) || await probeDimensions(filePath);

  if (ext === '.webp' || !['.jpg', '.jpeg', '.png'].includes(ext) || !await hasTool('cwebp')) {
    return {
      file: filePath, ext, bytes: origBytes, origBytes,
      width: origDims?.width, height: origDims?.height,
      mime: MIME_BY_EXT[ext] || 'image/jpeg', changed: false,
    };
  }

  const targetPath = filePath.replace(/\.(?:jpe?g|png)$/i, '.webp');
  const tmpPath = `${targetPath}.opt.tmp.webp`;
  const args = ['-quiet', '-q', String(ext === '.png' ? Math.min(84, quality + 2) : quality), '-m', '4'];
  let resized = false;
  if (origDims && Math.max(origDims.width, origDims.height) > maxDimension) {
    if (origDims.width >= origDims.height) args.push('-resize', String(maxDimension), '0');
    else args.push('-resize', '0', String(maxDimension));
    resized = true;
  }
  args.push(filePath, '-o', tmpPath);

  try {
    await execFile('cwebp', args, { timeout: 30000 });
    const newBuf = await readFile(tmpPath);
    const newBytes = newBuf.length;
    if (newBytes > 0 && (newBytes < origBytes || resized)) {
      await rename(tmpPath, targetPath);
      if (targetPath !== filePath) await rm(filePath, { force: true });
      const newDims = readImageDimensions(newBuf) || origDims;
      return {
        file: targetPath, ext: '.webp', bytes: newBytes, origBytes,
        width: newDims?.width, height: newDims?.height,
        mime: 'image/webp', changed: true,
      };
    }
    await rm(tmpPath, { force: true });
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
  }

  return {
    file: filePath, ext, bytes: origBytes, origBytes,
    width: origDims?.width, height: origDims?.height,
    mime: MIME_BY_EXT[ext] || 'image/jpeg', changed: false,
  };
}

export async function optimizeVideoFile(filePath, { maxWidth = 960, crf = 28 } = {}) {
  const origBytes = (await stat(filePath)).size;
  if (!await hasTool('ffmpeg')) {
    return { file: filePath, bytes: origBytes, origBytes, changed: false };
  }
  const tmpPath = `${filePath}.opt.tmp.mp4`;
  try {
    await execFile('ffmpeg', [
      '-y', '-v', 'error', '-i', filePath,
      '-c:v', 'libx264', '-crf', String(crf), '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      tmpPath,
    ], { timeout: 120000 });
    const newBytes = (await stat(tmpPath)).size;
    if (newBytes > 0 && newBytes < origBytes * 0.96) {
      await rename(tmpPath, filePath);
      return { file: filePath, bytes: newBytes, origBytes, changed: true };
    }
    await rm(tmpPath, { force: true });
    // Even if re-encode wasn't smaller, remux to ensure moov faststart for instant playback.
    await execFile('ffmpeg', [
      '-y', '-v', 'error', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmpPath,
    ], { timeout: 30000 });
    const remuxBytes = (await stat(tmpPath)).size;
    if (remuxBytes > 0) {
      await rename(tmpPath, filePath);
      return { file: filePath, bytes: remuxBytes, origBytes, changed: true };
    }
    await rm(tmpPath, { force: true });
  } catch {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
  return { file: filePath, bytes: origBytes, origBytes, changed: false };
}
