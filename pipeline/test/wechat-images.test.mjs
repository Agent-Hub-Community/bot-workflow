import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  accountImageKey, convertToJpeg, decodeDat, deriveImageKey, imageFileHash, imageFormat, locateImage,
} from '../wechat-images.mjs';
import { encodeDat, jpeg, md5 } from './dat-fixture.mjs';

const key = deriveImageKey('123456789', 'wxid_demo');

test('V2 files decode back to the original bytes for every size layout', () => {
  for (const [size, middle] of [[700, 0], [1024, 0], [5000, 0], [9000, 3000]]) {
    const image = jpeg(size);
    const decoded = decodeDat(encodeDat(image, { ...key, middle }), key);
    assert.equal(decoded.version, 'v2');
    assert.equal(decoded.format, 'jpg');
    assert.ok(decoded.data.equals(image), `size ${size}, middle ${middle}`);
  }
});

test('V1 files use the fixed client key and the account XOR key', () => {
  const image = jpeg(3000);
  const decoded = decodeDat(encodeDat(image, { version: 'v1', xorKey: key.xorKey }), { xorKey: key.xorKey });
  assert.equal(decoded.version, 'v1');
  assert.ok(decoded.data.equals(image));
});

test('legacy XOR files are recognised from the image signature', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
  const decoded = decodeDat(Buffer.from(png.map(byte => byte ^ 0x5a)), undefined);
  assert.deepEqual([decoded.version, decoded.format], ['xor', 'png']);
  assert.ok(decoded.data.equals(png));
});

test('a wrong key, a missing key or a truncated file fails instead of returning garbage', () => {
  const dat = encodeDat(jpeg(4000), key);
  assert.throws(() => decodeDat(dat, deriveImageKey('987654321', 'wxid_demo')), /key may be wrong/);
  assert.throws(() => decodeDat(dat, undefined), /needs the account image key/);
  assert.throws(() => decodeDat(dat.subarray(0, 500), key), /truncated/);
  assert.throws(() => decodeDat(randomBytes(100).fill(1), key), /Unknown \.dat format/);
});

test('the account key comes from the uin whose md5 matches the directory suffix', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wechat-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uin = '123456789', suffix = md5(uin).slice(0, 4);
  assert.notEqual(md5('987654321').slice(0, 4), suffix);
  const account = path.join(root, 'Documents', 'xwechat_files', `wxid_demo_${suffix}`);
  const kvcomm = path.join(root, 'Documents', 'app_data', 'net', 'kvcomm');
  await mkdir(account, { recursive: true });
  await mkdir(kvcomm, { recursive: true });
  await writeFile(path.join(kvcomm, 'config.ini'), '[default]\nlast_uin=\n');
  await writeFile(path.join(kvcomm, 'key_987654321_1_2_3600_input.statistic'), '');
  await assert.rejects(accountImageKey(account), /No uin on disk matches/);

  await writeFile(path.join(kvcomm, `key_${uin}_1_2_3600_input.statistic`), '');
  const image = jpeg(2000);
  assert.ok(decodeDat(encodeDat(image, deriveImageKey(uin, 'wxid_demo')), await accountImageKey(account)).data.equals(image));

  // Newer clients keep the uin base64-encoded under radium/ilink/<suffix…>/kvcomm.
  await rm(kvcomm, { recursive: true });
  const ilink = path.join(root, 'Documents', 'app_data', 'radium', 'ilink', `${suffix}abc`, 'kvcomm');
  await mkdir(ilink, { recursive: true });
  await writeFile(path.join(ilink, 'config.ini'), `[default]\nlast_uin=${Buffer.from(uin).toString('base64')}\n`);
  assert.ok(decodeDat(encodeDat(image, deriveImageKey(uin, 'wxid_demo')), await accountImageKey(account)).data.equals(image));
});

test('the file hash is the single 32-character hex string in packed_info_data', () => {
  const hash = 'a'.repeat(16) + '0123456789abcdef';
  assert.equal(imageFileHash(Buffer.concat([Buffer.from('0808100b1a222220', 'hex'), Buffer.from(hash)])), hash);
  assert.equal(imageFileHash(null), null);
  assert.equal(imageFileHash(Buffer.from('080810')), null);
  assert.throws(() => imageFileHash(Buffer.from(`${hash}:${'b'.repeat(32)}`)), /Ambiguous/);
});

test('full images win over the thumbnail, and the HD copy over the plain one', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wechat-attach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const username = '1@chatroom', created = Date.parse('2026-10-15T12:00:00Z') / 1000, hash = 'c'.repeat(32);
  const dir = path.join(root, md5(username), '2026-10', 'Img');
  await mkdir(dir, { recursive: true });
  assert.deepEqual(await locateImage(root, username, created, hash), { quality: 'missing', file: null });
  await writeFile(path.join(dir, `${hash}_t.dat`), '');
  assert.deepEqual(await locateImage(root, username, created, hash), { quality: 'thumbnail', file: path.join(dir, `${hash}_t.dat`) });
  await writeFile(path.join(dir, `${hash}.dat`), '');
  assert.equal((await locateImage(root, username, created, hash)).file, path.join(dir, `${hash}.dat`));
  await writeFile(path.join(dir, `${hash}_h.dat`), '');
  assert.deepEqual(await locateImage(root, username, created, hash), { quality: 'original', file: path.join(dir, `${hash}_h.dat`) });
  assert.equal((await locateImage(root, username, created, null)).quality, 'missing');
});

const hevc = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1',
  '-c:v', 'libx265', '-x265-params', 'log-level=error', '-f', 'hevc', 'pipe:1'], { maxBuffer: 1 << 20 });

test('wxgf images become a JPEG through ffmpeg', { skip: hevc.status !== 0 && 'ffmpeg with libx265 is not available' }, async () => {
  const wxgf = Buffer.concat([Buffer.from('wxgf'), Buffer.from([0x12, 0, 2, 4, 0x98, 3, 0xd4, 0, 0, 0]), hevc.stdout]);
  assert.equal(imageFormat(wxgf), 'wxgf');
  const jpg = await convertToJpeg(wxgf, 'wxgf');
  assert.equal(imageFormat(jpg), 'jpg');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: jpg });
  assert.equal(probe.stdout.toString().trim(), '64,48');
  await assert.rejects(convertToJpeg(Buffer.from('wxgf-no-stream'), 'wxgf'), /no HEVC start code/);
});
