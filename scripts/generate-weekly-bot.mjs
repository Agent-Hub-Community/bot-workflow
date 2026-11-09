// Writes the single combined group message for one weekly edition, in the same hook style as the daily message:
// the daily prompt plus prompts/weekly-bot.md, with the same format and length checks (lib/bot-message.mjs).
// Before 2026-11-09 this message only listed each page title, which group feedback found too dry to click.
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../lib/newspaper-root.mjs';
import { botSections, writeBotMessage } from '../lib/bot-message.mjs';
const { weeklyRoute } = await load('lib/weekly-editions.mjs');
const { site: publicSite } = await load('lib/site.mjs');

const [,, issueFile, outputFile, ...args] = process.argv;
if (!issueFile || !outputFile) {
  throw new Error('Usage: generate-weekly-bot.mjs ISSUE_JSON OUTPUT_MD [--base-url URL] [--split-dir DIR] [--notes FILE]');
}
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
// Without --base-url the message is a preview: the overview link is still the public one, but the first line
// says it has not been checked online yet.
const baseUrl = (option('--base-url') || publicSite).replace(/\/$/, '');
const preview = !option('--base-url');
const splitDir = option('--split-dir') ? path.resolve(option('--split-dir')) : null;
const notesFile = option('--notes');
const issue = JSON.parse(await readFile(path.resolve(issueFile), 'utf8'));
const label = issue.label.replace(/\s*周报\s*$/, '');
const { sections, blocks } = botSections(issue.pages);
const prompt = file => readFile(new URL(`../prompts/${file}`, import.meta.url), 'utf8');
const notes = notesFile ? await readFile(notesFile, 'utf8') : '';
const system = `${await prompt('daily-bot.md')}\n${await prompt('weekly-bot.md')}${notes ? `\n本期注意：\n${notes}` : ''}`;
const output = path.resolve(outputFile);
const message = await writeBotMessage({
  firstLine: `AgentHub ${label} 周报${preview ? '导览（链接待上线核验）' : '已上线'}`,
  overviewUrl: `${baseUrl}/${weeklyRoute(issue, 'overview')}`,
  sections, blocks, system, output,
  emptyPattern: /本周未选编|暂无稿件|无.{0,2}版面/,
});
if (splitDir) {
  await mkdir(splitDir, { recursive: true });
  await copyFile(output, path.join(splitDir, `${issue.id}-bot.md`));
}
console.log(message);
