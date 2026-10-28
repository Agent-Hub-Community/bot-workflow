// Writes the single combined group message for one daily issue.
// DATA is the publication read-back (.data.json with digests) or a preview issue (final-reader-issue.json).
import { readFile, writeFile, rm } from 'node:fs/promises';
import { llmModel, llmUrl, llmHeaders } from '../lib/llm.mjs';
import { load } from '../lib/newspaper-root.mjs';
const { site: publicSite } = await load('lib/site.mjs');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const notesFile = option('--notes');
const site = (option('--site') || publicSite).replace(/\/$/, '');
const preview = args.includes('--preview');
if (preview) args.splice(args.indexOf('--preview'), 1);
const [dataFile, date, output] = args;
if (!dataFile || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !output) {
  throw new Error('Usage: generate-bot.mjs DATA_JSON YYYY-MM-DD OUTPUT_MD [--notes FILE] [--site URL] [--preview]');
}
const data = JSON.parse(await readFile(dataFile, 'utf8'));
const issue = Array.isArray(data.digests) ? data.digests.find(digest => digest.date === date) : data.date === date ? data : null;
if (!issue?.pages?.length) throw new Error(`No issue for ${date} in ${dataFile}`);
const firstLine = `AgentHub ${date.replaceAll('-', '.')} 日报${preview ? '导览（链接待上线核验）' : '已上线'}`;
const overviewUrl = `${site}/daily/${date}/overview/`;
// The message is an overview, so the model sees each page's heading, theme and story titles, not the
// story text; with full text it retold the stories in detail (2026-10-16).
// Pages without stories are left out of the message rather than announced as empty (2026-10-19).
const sections = issue.pages.filter(page => page.stories?.length).map(page => ({
  label: page.label,
  heading: page.heading, theme: page.theme, titles: page.stories.map(story => story.title),
}));
if (!sections.length) throw new Error(`No page with stories for ${date}`);
// The layout is fixed in code: main groups, topic groups (group-6 and later) and external news form
// separate blocks with one blank line between them, so the model only writes the summary lines.
const blockOf = page => page.id === 'external' ? 2 : Number(page.id?.match(/^group-(\d+)$/)?.[1]) >= 6 ? 1 : 0;
const blocks = issue.pages.filter(page => page.stories?.length).map(blockOf);
const notes = notesFile ? await readFile(notesFile, 'utf8') : '';
const system = `${await readFile(new URL('../prompts/daily-bot.md', import.meta.url), import.meta.url ? 'utf8' : 'utf8')}${notes ? `\n本期注意：\n${notes}` : ''}`;

await rm(output, { force: true });
await rm(`${output}.response.json`, { force: true });
const started = Date.now();
const response = await fetch(llmUrl, {
  method: 'POST',
  headers: llmHeaders(),
  body: JSON.stringify({ model: llmModel, max_tokens: 12000, stream: false, messages: [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ firstLine, overviewUrl, sections }) },
  ] }),
  signal: AbortSignal.timeout(300000),
});
if (!response.ok) throw new Error(`Bot HTTP ${response.status}`);
const result = await response.json();
await writeFile(`${output}.response.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
const choice = result.choices?.[0];
if (result.model !== llmModel || choice?.finish_reason !== 'stop' || !choice.message?.content?.trim()) {
  throw new Error('Unexpected model or incomplete response');
}
const text = choice.message.content.trim();
const links = (text.match(/https?:\/\/[^\s]+/g) || []);
const summaries = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('【'));
const labels = summaries.map(line => line.match(/^【(.+?)】/)?.[1]);
const problems = [
  ...(text.startsWith(firstLine) ? [] : ['first line']),
  ...(/\*\*|```|^#/m.test(text) ? ['Markdown markup'] : []),
  ...(JSON.stringify(links) === JSON.stringify([overviewUrl]) ? [] : [`links ${JSON.stringify(links)}`]),
  ...(/当天未选编|暂无稿件|无.{0,2}版面/.test(text) ? ['mentions an empty page'] : []),
  ...(JSON.stringify(labels) === JSON.stringify(sections.map(section => section.label)) ? [] : [`sections ${JSON.stringify(labels)}`]),
  ...(summaries.some(line => !line.replace(/^【.+?】/, '').trim()) ? ['empty summary'] : []),
];
if (problems.length) throw new Error(`Invalid bot message: ${problems.join('; ')}`);
const body = [0, 1, 2].map(block => summaries.filter((_, index) => blocks[index] === block))
  .filter(lines => lines.length).map(lines => lines.join('\n')).join('\n\n');
const message = `${firstLine}\n${overviewUrl}\n\n${body}`;
await writeFile(output, `${message}\n`, { mode: 0o600 });
await writeFile(`${output}.run.json`, JSON.stringify({ model: result.model, elapsedMs: Date.now() - started,
  usage: result.usage, review: 'pending' }, null, 2), { mode: 0o600 });
console.log(message);
