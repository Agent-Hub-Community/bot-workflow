// Writes the single combined group message for one daily issue.
// DATA is the publication read-back (.data.json with digests) or a preview issue (final-reader-issue.json).
import { readFile } from 'node:fs/promises';
import { load } from '../lib/newspaper-root.mjs';
import { botSections, writeBotMessage } from '../lib/bot-message.mjs';
const { site: publicSite } = await load('lib/site.mjs');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const notesFile = option('--notes');
const promptFile = option('--prompt');
const site = (option('--site') || publicSite).replace(/\/$/, '');
const preview = args.includes('--preview');
if (preview) args.splice(args.indexOf('--preview'), 1);
const [dataFile, date, output] = args;
if (!dataFile || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !output) {
  throw new Error('Usage: generate-bot.mjs DATA_JSON YYYY-MM-DD OUTPUT_MD [--notes FILE] [--prompt FILE] [--site URL] [--preview]');
}
const data = JSON.parse(await readFile(dataFile, 'utf8'));
const issue = Array.isArray(data.digests) ? data.digests.find(digest => digest.date === date) : data.date === date ? data : null;
if (!issue?.pages?.length) throw new Error(`No issue for ${date} in ${dataFile}`);
const { sections, blocks } = botSections(issue.pages);
if (!sections.length) throw new Error(`No page with stories for ${date}`);
const notes = notesFile ? await readFile(notesFile, 'utf8') : '';
const system = `${await readFile(promptFile || new URL('../prompts/daily-bot.md', import.meta.url), 'utf8')}${notes ? `\n本期注意：\n${notes}` : ''}`;
const message = await writeBotMessage({
  firstLine: `AgentHub ${date.replaceAll('-', '.')} 日报${preview ? '导览（链接待上线核验）' : '已上线'}`,
  overviewUrl: `${site}/daily/${date}/overview/`,
  sections, blocks, system, output,
  emptyPattern: /当天未选编|暂无稿件|无.{0,2}版面/,
});
console.log(message);
