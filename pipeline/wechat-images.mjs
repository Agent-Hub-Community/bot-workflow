// Reads chat images that the WeChat 4.x Mac client keeps under <account>/msg/attach.
// The client stores them as .dat files: V2 encrypts the first block with an account key derived from
// the uin, V1 uses a fixed key, and older files are a single-byte XOR. The account key is derived at
// run time from files the client leaves on disk; callers must not write or print it.
import { createDecipheriv, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const md5 = value => createHash('md5').update(value).digest('hex');
const V1_KEY = Buffer.from(md5('0').slice(0, 16), 'latin1');
const V1_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const SIGNATURES = [
  ['jpg', [0xff, 0xd8, 0xff]],
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['webp', [0x52, 0x49, 0x46, 0x46]],
  ['wxgf', [0x77, 0x78, 0x67, 0x66]],
];

export function imageFormat(data) {
  for (const [format, bytes] of SIGNATURES) {
    if (bytes.every((byte, i) => data[i] === byte)) {
      if (format === 'webp' && data.subarray(8, 12).toString('latin1') !== 'WEBP') continue;
      return format;
    }
  }
  return null;
}

export function deriveImageKey(uin, wxid) {
  return { aesKey: Buffer.from(md5(`${uin}${wxid}`).slice(0, 16), 'latin1'), xorKey: Number(BigInt(uin) & 0xffn) };
}

// Layout: 6-byte magic, AES length and XOR length (u32 LE), one flag byte, then the AES-128-ECB part,
// an unencrypted middle and the XOR tail. The AES part is stored with one extra block (PKCS#7 padding,
// or a trailer that newer clients vary), so it is decrypted whole and cut back to the stated length.
export function decodeDat(data, key) {
  const magic = data.subarray(0, 6);
  if (magic.equals(V1_MAGIC) || magic.equals(V2_MAGIC)) {
    const version = magic.equals(V2_MAGIC) ? 'v2' : 'v1';
    if (data.length < 15) throw new Error(`${version} .dat header is truncated`);
    const aesSize = data.readUInt32LE(6), xorSize = data.readUInt32LE(10);
    const cipherSize = (Math.floor(aesSize / 16) + 1) * 16;
    if (15 + cipherSize + xorSize > data.length) throw new Error(`${version} .dat body is truncated`);
    const aesKey = version === 'v1' ? V1_KEY : key?.aesKey;
    if (!aesKey) throw new Error('V2 .dat needs the account image key');
    if (xorSize && !Number.isInteger(key?.xorKey)) throw new Error(`${version} .dat needs the account XOR key`);
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null).setAutoPadding(false);
    const head = Buffer.concat([decipher.update(data.subarray(15, 15 + cipherSize)), decipher.final()]).subarray(0, aesSize);
    const rest = data.subarray(15 + cipherSize);
    const tail = Buffer.from(rest.subarray(rest.length - xorSize));
    for (let i = 0; i < tail.length; i++) tail[i] ^= key.xorKey;
    const image = Buffer.concat([head, rest.subarray(0, rest.length - xorSize), tail]);
    const format = imageFormat(image);
    if (!format) throw new Error(`${version} .dat did not decode to a known image format; the key may be wrong`);
    return { version, format, data: image };
  }
  for (const [format, bytes] of SIGNATURES) {
    const xor = data[0] ^ bytes[0];
    if (data.length > bytes.length && bytes.every((byte, i) => (data[i] ^ xor) === byte)) {
      const image = Buffer.from(data.map(byte => byte ^ xor));
      if (imageFormat(image) === format) return { version: 'xor', format, data: image };
    }
  }
  throw new Error('Unknown .dat format');
}

// Account directories are named <wxid>_<suffix>, where the suffix is the first four hex digits of md5(uin).
// That check picks the right uin from the client's files without trusting any single source.
export async function accountImageKey(accountDir) {
  const name = path.basename(accountDir);
  const parts = /^(.+)_([0-9a-f]{4})$/.exec(name);
  if (!parts) throw new Error(`Cannot read the account suffix from ${name}`);
  const [, wxid, suffix] = parts;
  const appData = path.join(accountDir, '..', '..', 'app_data');
  const lastUin = text => {
    const value = /^last_uin=(.*)$/m.exec(text)?.[1].trim();
    if (!value) return null;
    return /^\d+$/.test(value) ? value : Buffer.from(value, 'base64').toString('utf8').trim();
  };
  const candidates = [];
  const ilink = path.join(appData, 'radium', 'ilink');
  const ilinkDirs = await readdir(ilink).catch(() => []);
  for (const dir of ilinkDirs.toSorted((a, b) => Number(!a.startsWith(suffix)) - Number(!b.startsWith(suffix)))) {
    candidates.push(lastUin(await readFile(path.join(ilink, dir, 'kvcomm', 'config.ini'), 'utf8').catch(() => '')));
  }
  candidates.push(lastUin(await readFile(path.join(appData, 'net', 'kvcomm', 'config.ini'), 'utf8').catch(() => '')));
  for (const file of await readdir(path.join(appData, 'net', 'kvcomm')).catch(() => [])) {
    candidates.push(/^key_(\d+)_/.exec(file)?.[1]);
  }
  const uin = candidates.find(value => /^\d+$/.test(value || '') && value !== '0' && md5(value).startsWith(suffix));
  if (!uin) throw new Error(`No uin on disk matches account suffix ${suffix}`);
  return deriveImageKey(uin, wxid);
}

// packed_info_data is a small protobuf whose only 32-character hex string names the image file.
export function imageFileHash(packed) {
  if (!packed) return null;
  const hashes = new Set(Buffer.from(packed).toString('latin1').match(/[0-9a-f]{32}/g) || []);
  if (hashes.size > 1) throw new Error('Ambiguous image hash in packed_info_data');
  return hashes.size ? [...hashes][0] : null;
}

// The client files images by chat, local month and file hash. On receipt it downloads only <hash>_t.dat,
// a thumbnail about 100–200 px on the long side. Once the chat window shows the message (scrolling past
// it is enough) the client adds <hash>.dat, the standard image (its size matches the message's `size`),
// and for some images <hash>_h.dat (`hd_size`); opening the image or "查看原图" fetches _h as well.
// Both larger files count as the original here: either one shows the image at full resolution.
export async function locateImage(attachRoot, username, createTime, hash) {
  const time = new Date(createTime * 1000);
  const month = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(attachRoot, md5(username), month, 'Img');
  const files = new Set(await readdir(dir).catch(() => []));
  for (const [suffix, quality] of [['_h', 'original'], ['', 'original'], ['_t', 'thumbnail']]) {
    if (hash && files.has(`${hash}${suffix}.dat`)) return { quality, file: path.join(dir, `${hash}${suffix}.dat`) };
  }
  return { quality: 'missing', file: null };
}

// WeChat stores some images as wxgf, an HEVC bitstream behind a small header, and some as GIF.
// ffmpeg turns either into one JPEG frame so the image model gets a format it accepts.
export function convertToJpeg(data, format, { ffmpeg = 'ffmpeg' } = {}) {
  let input = data, demuxer = format;
  if (format === 'wxgf') {
    const start = data.indexOf(Buffer.from([0, 0, 0, 1]));
    if (start < 0) return Promise.reject(new Error('wxgf image has no HEVC start code'));
    input = data.subarray(start);
    demuxer = 'hevc';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-f', demuxer, '-i', 'pipe:0', '-frames:v', '1',
      '-q:v', '3', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => {
      const jpg = Buffer.concat(out);
      if (code === 0 && imageFormat(jpg) === 'jpg') resolve(jpg);
      else reject(new Error(`ffmpeg could not convert ${format}: ${Buffer.concat(err).toString().trim().slice(0, 200)}`));
    });
    child.stdin.end(input);
  });
}
