import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectImages } from '../collect-images.mjs';
import { encodeDat, fakeAccount, jpeg, md5 } from './dat-fixture.mjs';

const AES_KEY = Buffer.from('0123456789abcdef');
const XOR_KEY = 0x5a;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthub-collect-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const accountDir = await fakeAccount(home);
  const wxDir = path.join(home, '.wx-cli');
  const dbPath = path.join(wxDir, 'cache/message_0.db');
  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(path.join(wxDir, 'config.json'), JSON.stringify({ db_dir: path.join(accountDir, 'db_storage') }));
  await writeFile(path.join(wxDir, 'cache/_mtimes.json'), JSON.stringify({ 'message/message_0.db': { path: dbPath } }));
  const room = '12345@chatroom';
  const ts = 1792461600; // 2026-10-20 10:00:00 +08:00
  const date = '2026-10-20';
  const db = new DatabaseSync(dbPath);
  const table = `Msg_${md5(room)}`;
  db.exec(`CREATE TABLE [${table}] (local_id INTEGER, create_time INTEGER, packed_info_data BLOB)`);
  const hashA = 'a'.repeat(32);
  const hashB = 'b'.repeat(32);
  db.prepare(`INSERT INTO [${table}] VALUES (?, ?, ?)`).run(1, ts, Buffer.from(`prefix${hashA}suffix`));
  db.prepare(`INSERT INTO [${table}] VALUES (?, ?, ?)`).run(2, ts + 60, Buffer.from(`prefix${hashB}suffix`));
  db.close();

  const attachDir = path.join(accountDir, 'msg', 'attach', md5(room), '2026-10', 'Img');
  await mkdir(attachDir, { recursive: true });
  const imgBytes = jpeg(2048);
  await writeFile(path.join(attachDir, `${hashA}.dat`), encodeDat(imgBytes, { version: 'v1', aesKey: AES_KEY, xorKey: XOR_KEY }));

  const batch = path.join(dir, 'batch');
  const dayDir = path.join(batch, date);
  await mkdir(dayDir, { recursive: true });
  const raw = [
    { local_id: 1, timestamp: ts, time: '2026-10-20 10:00:00', type: '图片', sender: 'Alice', content: '[图片]' },
    { local_id: 2, timestamp: ts + 60, time: '2026-10-20 10:01:00', type: '图片', sender: 'Bob', content: '[图片]' },
  ];
  const input = {
    date, cutoff: '2026-10-20T16:00:00.000Z',
    group: { id: 'group-1', label: '一群' },
    coverage: { count: 2, completeDay: true },
    messages: [
      { id: 'm0001', time: '2026-10-20 10:00:00', type: '图片', speaker: 'p1', content: '[图片]' },
      { id: 'm0002', time: '2026-10-20 10:01:00', type: '图片', speaker: 'p2', content: '[图片]' },
    ],
  };
  await writeFile(path.join(dayDir, 'group-1.raw.json'), JSON.stringify(raw, null, 2));
  await writeFile(path.join(dayDir, 'group-1.input.json'), JSON.stringify(input, null, 2));

  return {
    dayDir, imgBytes,
    run: opts => collectImages(date, batch, { home, groups: [{ id: 'group-1', username: room }], log: () => {}, ...opts }),
  };
}

test('collect-images decodes available .dat files locally without calling any external model', async t => {
  const { dayDir, imgBytes, run } = await fixture(t);
  const { pages, failures } = await run();
  assert.deepEqual(failures, []);
  assert.equal(pages.length, 1);
  const stored = JSON.parse(await readFile(path.join(dayDir, 'group-1.input.json'), 'utf8'));
  assert.equal(stored.messages[0].image.quality, 'original');
  assert.equal(stored.messages[0].image.file, 'media/group-1/m0001.jpg');
  assert.equal(stored.messages[1].image.quality, 'missing');
  assert.equal(stored.messages[1].image.file, undefined);
  const decoded = await readFile(path.join(dayDir, 'media/group-1/m0001.jpg'));
  assert.deepEqual(decoded.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(decoded.length, imgBytes.length);
});
