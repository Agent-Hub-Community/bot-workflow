import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load, rootDir } from '../lib/newspaper-root.mjs';
import { collectedChatGroups } from './chat-groups.mjs';

const { sanitizeInput } = await load('lib/daily-generation.mjs');

// Exports one day of every collected group through the wx CLI (WX_BIN, default `wx` on PATH).
// Output goes to DAILY_OUTPUT_DIR, by default scratch/daily/<date>/ of the newspaper checkout (ignored by git).
const date = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Usage: WX_ACTIVITY_HOME=... node collect-daily.mjs YYYY-MM-DD');
if (!process.env.WX_ACTIVITY_HOME) throw new Error('Set WX_ACTIVITY_HOME to the verified AgentHub account home.');
const start = Date.parse(`${date}T00:00:00+08:00`) / 1000;
if (!Number.isFinite(start) || new Date(start * 1000 + 8 * 3600_000).toISOString().slice(0, 10) !== date) throw new Error('Invalid date');
const cutoff = Math.min(Math.floor(Date.now() / 1000), start + 86400);
if (cutoff <= start) throw new Error('Cannot collect a future date.');
const nextDate = new Date((start + 86400 + 8 * 3600) * 1000).toISOString().slice(0, 10);
const groups = await collectedChatGroups(date);
const out = process.env.DAILY_OUTPUT_DIR
  ? path.resolve(process.env.DAILY_OUTPUT_DIR)
  : path.join(rootDir, 'scratch/daily', date);
await mkdir(out, { recursive: true, mode: 0o700 });
const selected = process.env.DAILY_GROUP
  ? groups.filter(group => group.id === process.env.DAILY_GROUP) : groups;
if (!selected.length) throw new Error('Unknown DAILY_GROUP');
for (const group of selected) {
  let raw = [], exhausted = false;
  const pageHashes = new Set();
  for (let offset = 0; offset < 10000; offset += 500) {
    const stdout = execFileSync(process.env.WX_BIN || 'wx', [
      'history', group.username, '--since', date, '--until', nextDate,
      '-n', '500', '--offset', String(offset), '--json',
    ], { env: { ...process.env, HOME: process.env.WX_ACTIVITY_HOME }, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    const batch = JSON.parse(stdout.toString());
    if (!Array.isArray(batch)) throw new Error(`Unexpected history response for ${group.id}`);
    const hash = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    if (batch.length && pageHashes.has(hash)) throw new Error(`Repeated page for ${group.id}`);
    pageHashes.add(hash);
    raw.push(...batch);
    if (batch.length < 500) { exhausted = true; break; }
  }
  if (!exhausted) throw new Error(`History limit reached for ${group.id}; do not summarize partial export.`);
  raw = raw.filter(m => m.timestamp >= start && m.timestamp < cutoff).sort((a, b) => a.timestamp - b.timestamp || a.local_id - b.local_id);
  await writeFile(path.join(out, `${group.id}.raw.json`), JSON.stringify(raw, null, 2), { mode: 0o600 });
  const senders = new Map();
  const messages = raw.map((m, i) => {
    if (m.sender && !senders.has(m.sender)) senders.set(m.sender, `p${senders.size + 1}`);
    return {
      id: `m${String(i + 1).padStart(4, '0')}`, time: m.time,
      speaker: m.sender ? senders.get(m.sender) : null, type: m.type,
      content: m.content,
    };
  });
  const payload = {
    group: { id: group.id, label: group.label }, date,
    cutoff: new Date(cutoff * 1000).toISOString(), timezone: 'Asia/Shanghai',
    coverage: {
      status: raw.length ? 'local_records' : 'no_local_records',
      completeDay: cutoff === start + 86400, paginationExhausted: exhausted,
      note: '仅代表当前账号本地可读记录；不保证其他设备或入群前历史完整。',
      count: raw.length, first: raw[0]?.time || null, last: raw.at(-1)?.time || null,
    }, messages,
  };
  await writeFile(path.join(out, `${group.id}.input.json`), JSON.stringify(sanitizeInput(payload), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ group: group.id, ...payload.coverage, cutoff: payload.cutoff }));
}
