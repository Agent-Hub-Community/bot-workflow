import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { load } from '../lib/newspaper-root.mjs';
const { weeklyRoute } = await load('lib/weekly-editions.mjs');

const [,, issueFile, outputFile, ...args] = process.argv;
if (!issueFile || !outputFile) {
  throw new Error('Usage: generate-weekly-bot.mjs ISSUE_JSON OUTPUT_MD [--base-url URL]');
}
const baseIndex = args.indexOf('--base-url');
const baseUrl = baseIndex >= 0 ? args[baseIndex + 1].replace(/\/$/, '') : '';
const splitIndex = args.indexOf('--split-dir');
const splitDir = splitIndex >= 0 ? path.resolve(args[splitIndex + 1]) : null;
const issue = JSON.parse(await readFile(path.resolve(issueFile), 'utf8'));
const statusLine = baseUrl
  ? '周报页面已上线，发送前请再确认链接和本期覆盖范围。'
  : '本地预览文案，未发群。正式发送前替换为线上核验过的周报地址。';
const publicationCheck = baseUrl
  ? '- 外部资讯和周榜使用本期独立入口，发送前再次确认页面可打开。'
  : '- 外部资讯和周榜使用本期独立入口；本地预览阶段不发送。';
const label = issue.label.replace(/\s*周报\s*$/, '');
const overviewLink = baseUrl
  ? `${baseUrl}/${weeklyRoute(issue, 'overview')}`
  : '周报总览链接待上线后补充';
const summary = page => page.title || page.stories.slice(0, 2).map(story => story.title).join('；');
const mainPages = issue.pages.filter(page => /^group-[1-5]$/.test(page.id));
const topicalPages = issue.pages.filter(page => page.id !== 'external' && !/^group-[1-5]$/.test(page.id));
const externalPage = issue.pages.find(page => page.id === 'external');

const lines = [
  `AgentHub ${label}周报已上线`,
  overviewLink,
  '',
  ...mainPages.map(page => `【${page.label}】${summary(page)}`),
  ...(topicalPages.length ? ['', ...topicalPages.map(page => `【${page.label}】${summary(page)}`)] : []),
  ...(externalPage ? ['', `【外部资讯】${summary(externalPage)}`] : []),
];
await writeFile(path.resolve(outputFile), lines.join('\n') + '\n');
if (splitDir) {
  await mkdir(splitDir, { recursive: true });
  await writeFile(path.join(splitDir, `${issue.id}-bot.md`), lines.join('\n') + '\n');
}
console.log(JSON.stringify({ output: path.resolve(outputFile), messages: 1, pages: issue.pages.length }));
