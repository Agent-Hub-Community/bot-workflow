// Loads the private chat record day by day for the library and glossary collectors. Speakers are per-day
// pseudonyms (p1, p2, ...); nothing here may be written outside the ignored scratch/ directory.
// `root` is the newspaper checkout: daily inputs come from <root>/scratch/, weekly exports from <root>/../reports/.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../lib/newspaper-root.mjs';

const { parseMessages } = await load('lib/content.mjs');
const { isGroupId } = await load('lib/groups.mjs');

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else yield file;
  }
}

// Daily inputs come from the newest batch per date and group; Agent Hub (group 1) weekly exports fill the days
// before the first daily input. Returns [{ date, group, source, messages: [{ time, speaker, content }] }].
export async function loadChatDays(root, { since = '0000-00-00' } = {}) {
  const inputs = new Map();
  for await (const file of walk(path.join(root, 'scratch'))) {
    const match = file.match(/(\d{4}-\d{2}-\d{2})\/(group-\d+)\.input\.json$/);
    if (match && !isGroupId(match[2])) continue;
    if (!match || match[1] < since) continue;
    const key = match.slice(1).join('/');
    const modified = (await stat(file)).mtimeMs;
    if (!inputs.has(key) || inputs.get(key).modified < modified) inputs.set(key, { file, modified, date: match[1], group: match[2] });
  }
  const days = [];
  for (const { file, date, group } of inputs.values()) {
    const input = JSON.parse(await readFile(file, 'utf8'));
    days.push({ date, group, source: 'daily-input', messages: input.messages.map(message => ({
      time: message.time.slice(11), speaker: message.speaker, content: message.content,
    })) });
  }
  const firstDaily = [...inputs.values()].filter(input => input.group === 'group-1').map(input => input.date).sort()[0] || '9999-99-99';
  const reports = path.join(root, '..', 'reports');
  for (const week of (await readdir(reports).catch(() => [])).sort()) {
    const text = await readFile(path.join(reports, week, 'agent-hub/messages.txt'), 'utf8').catch(() => null);
    if (!text) continue;
    const speakers = new Map();
    const byDate = new Map();
    for (const message of parseMessages(text, week)) {
      if (message.date < since || message.date >= firstDaily) continue;
      if (!speakers.has(message.author)) speakers.set(message.author, `p${speakers.size + 1}`);
      if (!byDate.has(message.date)) byDate.set(message.date, []);
      byDate.get(message.date).push({ time: message.time, speaker: speakers.get(message.author), content: message.text });
    }
    for (const [date, messages] of byDate) days.push({ date, group: 'group-1', source: 'weekly-export', messages });
  }
  return { days: days.sort((a, b) => a.date.localeCompare(b.date) || a.group.localeCompare(b.group)), dailyInputs: inputs.size, firstDaily };
}
