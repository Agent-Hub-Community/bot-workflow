import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../../lib/newspaper-root.mjs';
const { readerPage } = await load('lib/daily-generation.mjs');
const { isGroupId } = await load('lib/groups.mjs');

const [directory, variant = 'agent'] = process.argv.slice(2);
if (!directory || !['agent', 'llm'].includes(variant)) throw new Error('Usage: node "$BOT/legacy/scripts/package-daily.mjs" DIRECTORY [agent|llm]');
const inputs = [], pages = [];
const groups = (await readdir(directory)).filter(file => file.endsWith('.input.json'))
  .map(file => file.replace('.input.json', '')).filter(isGroupId).sort();
if (!groups.length) throw new Error('No collected group inputs');
for (const id of groups) {
  const input = JSON.parse(await readFile(path.join(directory, `${id}.input.json`), 'utf8'));
  const draft = JSON.parse(await readFile(path.join(directory, `${id}.${variant}.json`), 'utf8'));
  if (input.group.id !== id) throw new Error('Group mismatch');
  inputs.push(input);
  pages.push(readerPage(draft, input));
}
if (inputs.some(i => i.date !== inputs[0].date || i.cutoff !== inputs[0].cutoff)) throw new Error('Inconsistent reporting windows');
const issue = { id: inputs[0].date, date: inputs[0].date, label: `${inputs[0].date} 日报试稿`, pages };
await writeFile(path.join(directory, `${variant}.issue.json`), JSON.stringify(issue, null, 2), { mode: 0o600 });
await writeFile(path.join(directory, `${variant}.summary.md`), `# AgentHub ${issue.date} 日报试稿\n\n截至北京时间 ${new Date(inputs[0].cutoff).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。未发布。\n\n${pages.map(p => `## ${p.label}：${p.heading}\n\n${p.theme}\n\n${p.stories.map((s, i) => `### ${i + 1}. ${s.title}\n\n${s.text}`).join('\n\n')}`).join('\n\n')}\n`, { mode: 0o600 });
console.log(JSON.stringify({ issue: path.join(directory, `${variant}.issue.json`), groups: pages.map(p => ({ label: p.label, stories: p.stories.length })) }));
