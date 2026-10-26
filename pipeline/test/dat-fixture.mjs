// Synthetic WeChat image files for tests; no real image or account key is used.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const md5 = value => createHash('md5').update(value).digest('hex');

// The client's layout under Documents/: an account directory named <wxid>_<md5(uin)[:4]> and the
// app_data file whose name carries the uin, which accountImageKey() reads.
export async function fakeAccount(root, { uin = '123456789', wxid = 'wxid_demo' } = {}) {
  const accountDir = path.join(root, 'Documents', 'xwechat_files', `${wxid}_${md5(uin).slice(0, 4)}`);
  const kvcomm = path.join(root, 'Documents', 'app_data', 'net', 'kvcomm');
  await mkdir(path.join(accountDir, 'db_storage'), { recursive: true });
  await mkdir(kvcomm, { recursive: true });
  await writeFile(path.join(kvcomm, `key_${uin}_1_2_3600_input.statistic`), '');
  return accountDir;
}
export const jpeg = size => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 6), Buffer.from([0xff, 0xd9])]);

// Lays a .dat out the way the client does: header, AES-ECB part with PKCS#7, raw middle, XOR tail.
export function encodeDat(image, { version = 'v2', aesKey, xorKey, middle = 0 }) {
  const aesSize = Math.min(1024, image.length);
  const xorSize = image.length - aesSize - middle;
  const cipher = createCipheriv('aes-128-ecb', version === 'v1' ? Buffer.from(md5('0').slice(0, 16)) : aesKey, null);
  const header = Buffer.alloc(15);
  Buffer.from([0x07, 0x08, 0x56, version === 'v2' ? 0x32 : 0x31, 0x08, 0x07]).copy(header);
  header.writeUInt32LE(aesSize, 6);
  header.writeUInt32LE(xorSize, 10);
  header[14] = 1;
  const tail = Buffer.from(image.subarray(aesSize + middle).map(byte => byte ^ xorKey));
  return Buffer.concat([header, cipher.update(image.subarray(0, aesSize)), cipher.final(),
    image.subarray(aesSize, aesSize + middle), tail]);
}
