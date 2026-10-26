// Exports chat text in chunks for reviewers who look for group jargon (see the newspaper's GLOSSARY_REVIEW.md).
//   node "$PIPELINE/collect-glossary-chunks.mjs" [--since YYYY-MM-DD] [--size 1800]
// Output goes to scratch/glossary/chunk-NN.txt of the newspaper checkout. Only message text is kept: links, media,
// quoted replies and @mentions are removed because they carry nicknames; speakers stay per-day pseudonyms.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, rootDir as root } from '../lib/newspaper-root.mjs';
import { loadChatDays } from './chat-days.mjs';

const { groupLabels } = await load('lib/groups.mjs');
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
const since = option('--since', '0000-00-00');
const size = Number(option('--size', 1800));
const out = path.join(root, 'scratch/glossary');

export function cleanForGlossary(content) {
  let text = String(content || '');
  if (/^\[(?:图片|表情|视频|语音|文件|链接|系统|媒体引用未解析)\]/.test(text)) return '';
  text = text.replace(/^\[引用\]\s*/, '').split('↳')[0];
  text = text.replace(/https?:\/\/\S+/g, ' ').replace(/@\S+/g, '@某人').replace(/\[[^\]\s]{1,6}\]/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { days } = await loadChatDays(root, { since });
  const lines = days.flatMap(day => day.messages.map(message => {
    const text = cleanForGlossary(message.content);
    return text.length >= 2 ? `${day.date} ${groupLabels[day.group]} ${message.time} ${message.speaker}: ${text}` : null;
  }).filter(Boolean));
  await mkdir(out, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(out)).filter(name => /^chunk-\d+\.txt$/.test(name))) await rm(path.join(out, name));
  const chunks = Math.ceil(lines.length / size);
  for (let index = 0; index < chunks; index++) {
    await writeFile(path.join(out, `chunk-${String(index + 1).padStart(2, '0')}.txt`), `${lines.slice(index * size, (index + 1) * size).join('\n')}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ since, messages: lines.length, chunks, out: path.relative(root, out) }));
}
