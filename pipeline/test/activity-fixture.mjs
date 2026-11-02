// Builds a fake WeChat cache (two overlapping message shards and contact.db) plus an approved public-activity
// snapshot, so the ranking scripts run without a real WeChat database.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const placeholderAvatar = await readFile(new URL('./fixtures/placeholder-avatar.png', import.meta.url));
export const jpeg = Buffer.from([255, 216, 255, 0]);

export const saver = dir => async (name, value) => {
  await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
  await writeFile(path.join(dir, name), Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

// messages: { chatroomUsername: [[timestamp, localType, sender], ...] }; contacts: { sender: avatarUrl }.
export async function activityFixture(dir, { messages, contacts, historicalIds, historicalDate }) {
  const save = saver(dir);
  const rank = { leaders: [{ key: 'member-001', rank: 1 }] };
  await save('data/public-activity/snapshot.json', {
    generatedAt: `${historicalDate}T16:00:00Z`,
    windows: Object.fromEntries(['week', 'month', 'all'].map(id => [id, { from: null, through: historicalDate }])),
    ranks: { week: rank, month: rank, all: rank },
    groups: historicalIds.map(id => ({ id, first: historicalDate, last: historicalDate, available: true, daily: { [historicalDate]: rank } })),
    avatars: { 'member-001': 'avatars/member-001.jpg' },
  });
  await save('data/public-activity/avatars/member-001.jpg', Buffer.from('historical-image'));
  const cache = {};
  const contactPath = path.join(dir, 'contact.db');
  const contact = new DatabaseSync(contactPath);
  contact.exec('CREATE TABLE contact (username TEXT, small_head_url TEXT, big_head_url TEXT)');
  for (const [username, url] of Object.entries(contacts)) contact.prepare('INSERT INTO contact VALUES (?, ?, NULL)').run(username, url);
  contact.close();
  cache['contact/contact.db'] = { path: contactPath };
  const senders = [...new Set(Object.values(messages).flat().map(row => row[2]))];
  // Both shards hold the same rows, so the collector's deduplication is exercised too.
  for (let shard = 0; shard < 2; shard++) {
    const file = path.join(dir, `message-${shard}.db`), db = new DatabaseSync(file);
    cache[`message/message_${shard}.db`] = { path: file };
    db.exec('CREATE TABLE Name2Id (user_name TEXT)');
    for (const sender of senders) db.prepare('INSERT INTO Name2Id VALUES (?)').run(sender);
    for (const [username, rows] of Object.entries(messages)) {
      const table = `Msg_${createHash('md5').update(username).digest('hex')}`;
      db.exec(`CREATE TABLE ${table} (local_id INTEGER, server_id INTEGER, create_time INTEGER, local_type INTEGER, real_sender_id INTEGER, message_content TEXT, WCDB_CT_message_content INTEGER)`);
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, 'text', 0)`);
      rows.forEach(([timestamp, type, sender], i) =>
        insert.run(i + 1, 6691791431834355264n + BigInt(i), timestamp, type, senders.indexOf(sender) + 1));
    }
    db.close();
  }
  await save('home/.wx-cli/cache/_mtimes.json', cache);
  return { home: path.join(dir, 'home'), root: pathToFileURL(dir + '/'), save };
}
