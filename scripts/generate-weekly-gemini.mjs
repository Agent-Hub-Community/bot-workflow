import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmModel, llmUrl, llmHeaders, llmMaxOutputTokens } from '../lib/llm.mjs';
import { load } from '../lib/newspaper-root.mjs';
import { modelMessages } from '../lib/weekly-discussion.mjs';
const { validateEmphasis } = await load('lib/emphasis.mjs');
const { modelInput } = await load('lib/image-messages.mjs');
const { collectedGroups, groupIds, isGroupId, pageGroups } = await load('lib/groups.mjs');

const root = fileURLToPath(new URL('../', import.meta.url));
const [from, through, inputDirArg, outputDirArg] = process.argv.slice(2);
if (![from, through].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date)) || !inputDirArg || !outputDirArg) {
  throw new Error('Usage: generate-weekly-gemini.mjs FROM THROUGH INPUT_DIR OUTPUT_DIR [--prior FILE] [--groups group-1,...]');
}
const inputDir = path.resolve(inputDirArg);
const outputDir = path.resolve(outputDirArg);
const priorFlag = process.argv.indexOf('--prior');
const prior = priorFlag >= 0 ? JSON.parse(await readFile(path.resolve(process.argv[priorFlag + 1]), 'utf8')) : null;
const model = llmModel;
const dates = [];
for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${through}T00:00:00Z`); time += 86400000) {
  dates.push(new Date(time).toISOString().slice(0, 10));
}
if (!dates.length || dates.length > 31) throw new Error('Expected a date range of 1-31 days');
// By default every group with a reader section on any day of the range, from the newspaper's lib/groups.mjs.
const groupsFlag = process.argv.indexOf('--groups');
const groups = groupsFlag >= 0 ? process.argv[groupsFlag + 1].split(',')
  : groupIds.filter(id => dates.some(date => pageGroups(date).some(group => group.id === id)));
for (const group of groups) if (!isGroupId(group)) throw new Error(`Unknown group: ${group}`);
if (!groups.length) throw new Error('Expected at least one group');
await mkdir(outputDir, { recursive: true, mode: 0o700 });

const prompt = await readFile(path.join(root, 'prompts/weekly-editor-gemini.md'), 'utf8');
async function messagesFor(group) {
  const messages = [];
  // Days before a group's collection start have no input; every collected day must have one.
  for (const date of dates.filter(date => collectedGroups(date).some(({ id }) => id === group))) {
    const input = JSON.parse(await readFile(path.join(inputDir, date, `${group}.input.json`), 'utf8'));
    messages.push(...modelMessages(input, date, group, modelInput));
  }
  return messages;
}
function cleanJson(content) {
  return content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}
function validatePage(page, group) {
  if (!page || typeof page.title !== 'string' || !page.title.trim() ||
      typeof page.intro !== 'string' || !page.intro.trim() || !Array.isArray(page.stories) || !page.stories.length) {
    throw new Error(`${group}: invalid page shape`);
  }
  for (const story of page.stories) {
    if (!story || typeof story.title !== 'string' || !story.title.trim() ||
        typeof story.text !== 'string' || !story.text.trim() ||
        typeof story.review !== 'string' || !story.review.trim() || !Array.isArray(story.emphasis)) {
      throw new Error(`${group}: invalid story shape`);
    }
    validateEmphasis(story.text, story.emphasis, {
      invalidMessage: `${group}: invalid emphasis span`, overlapMessage: `${group}: overlapping emphasis span`,
    });
    if (story.url && !/^https:\/\/[^\s]+$/.test(story.url)) throw new Error(`${group}: unsafe URL`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(`${story.title}${story.text}${story.review}`)) {
      throw new Error(`${group}: control character in story`);
    }
  }
}
async function generate(group) {
  const messages = await messagesFor(group);
  const priorPage = prior?.pages?.find(page => page.id === group);
  const input = `${prompt}\n\n本次刊期：${from} 至 ${through}。群别：${group}。\n` +
    (priorPage ? `上一版仅作为选题索引，不是事实来源；请以原始消息为准：\n${JSON.stringify(priorPage.stories.map(({ title, text }) => ({ title, text })))}\n\n` : '') +
    `全部原始消息如下。date 是消息日期，speaker 只是匿名定位符，不得输出：\n${JSON.stringify(messages)}`;
  await writeFile(path.join(outputDir, `${group}.prompt.md`), input, { mode: 0o600 });
  const started = Date.now();
  const response = await fetch(llmUrl, {
    method: 'POST',
    headers: llmHeaders(),
    // A whole week leaves no room for reasoning: high effort spent the full 32k cap without an answer.
    body: JSON.stringify({ model, messages: [{ role: 'user', content: input }], max_tokens: llmMaxOutputTokens, stream: false }),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`${group}: HTTP ${response.status}`);
  const result = await response.json();
  await writeFile(path.join(outputDir, `${group}.response.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (result.model !== model || result.choices?.[0]?.finish_reason !== 'stop') throw new Error(`${group}: unexpected model or incomplete response`);
  const page = JSON.parse(cleanJson(result.choices[0].message.content));
  validatePage(page, group);
  await writeFile(path.join(outputDir, `${group}.json`), JSON.stringify(page, null, 2) + '\n', { mode: 0o600 });
  await writeFile(path.join(outputDir, `${group}.run.json`), JSON.stringify({ model, messages: messages.length, stories: page.stories.length, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  return { group, messages: messages.length, stories: page.stories.length };
}
console.log(JSON.stringify(await Promise.all(groups.map(generate)), null, 2));
