// Shared by the daily and weekly group messages: builds the model input from reviewed pages, asks the model for
// one line per page, checks the format and length, sends an overlong draft back once, and lays out the blocks.
import { rm, writeFile } from 'node:fs/promises';
import { llmModel, llmUrl, llmHeaders } from './llm.mjs';

// Long messages get folded in WeChat groups (2026-10-28), so each line and the whole body have hard limits.
export const LIMITS = { line: 85, total: 700 };

const linkKey = url => {
  try {
    const u = new URL(url);
    const arxiv = u.hostname.endsWith('arxiv.org') && u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/);
    if (arxiv) return `arxiv:${arxiv[1]}`;
    const hf = u.hostname === 'huggingface.co' && u.pathname.match(/^\/papers\/(\d{4}\.\d{4,5})/);
    if (hf) return `arxiv:${hf[1]}`;
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch { return null; }
};

// The model sees each page's heading, theme, story titles, reviewed emphasis spans and AI comment, not the story
// text; with full text it retold the stories in detail (2026-10-16). Pages without stories are left out rather
// than announced as empty (2026-10-19). The same paper or project is often shared in several groups (2026-11-04:
// one CUA paper in four groups); stories whose resources share a link with another page carry `alsoIn`, so the
// message names that work once.
export function botSections(pages) {
  const withStories = pages.filter(page => page.stories?.length);
  const owners = new Map();
  for (const page of withStories) for (const story of page.stories) {
    for (const key of new Set((story.resources || []).map(r => linkKey(r.url)).filter(Boolean))) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(page.label);
    }
  }
  const alsoIn = (story, page) => {
    const others = new Set();
    for (const r of story.resources || []) for (const label of owners.get(linkKey(r.url)) || []) if (label !== page.label) others.add(label);
    return others.size ? { alsoIn: [...others] } : {};
  };
  const sections = withStories.map(page => ({
    label: page.label, heading: page.heading ?? page.title, theme: page.theme ?? page.intro,
    stories: page.stories.map(story => ({ title: story.title, highlights: story.emphasis || [],
      comment: story.aiComment || story.review || '', ...alsoIn(story, page) })),
  }));
  // Main groups, topic groups (group-6 and later) and external news form separate blocks in the message.
  const blocks = withStories.map(page => page.id === 'external' ? 2 : Number(page.id?.match(/^group-(\d+)$/)?.[1]) >= 6 ? 1 : 0);
  return { sections, blocks };
}

export async function writeBotMessage({ firstLine, overviewUrl, sections, blocks, system, output, emptyPattern }) {
  if (!sections.length) throw new Error('No page with stories');
  await rm(output, { force: true });
  await rm(`${output}.response.json`, { force: true });
  const started = Date.now();
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ firstLine, overviewUrl, sections }) },
  ];
  const ask = async () => {
    const response = await fetch(llmUrl, {
      method: 'POST', headers: llmHeaders(),
      body: JSON.stringify({ model: llmModel, max_tokens: 12000, stream: false, messages }),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new Error(`Bot HTTP ${response.status}`);
    const result = await response.json();
    const choice = result.choices?.[0];
    if (result.model !== llmModel || choice?.finish_reason !== 'stop' || !choice.message?.content?.trim()) {
      throw new Error('Unexpected model or incomplete response');
    }
    return { result, text: choice.message.content.trim() };
  };
  const chars = line => [...line].length;
  const check = text => {
    const summaries = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('【'));
    const links = text.match(/https?:\/\/[^\s]+/g) || [];
    const labels = summaries.map(line => line.match(/^【(.+?)】/)?.[1]);
    const errors = [
      ...(text.startsWith(firstLine) ? [] : ['first line']),
      ...(/\*\*|```|^#/m.test(text) ? ['Markdown markup'] : []),
      ...(JSON.stringify(links) === JSON.stringify([overviewUrl]) ? [] : [`links ${JSON.stringify(links)}`]),
      ...(emptyPattern?.test(text) ? ['mentions an empty page'] : []),
      ...(JSON.stringify(labels) === JSON.stringify(sections.map(section => section.label)) ? [] : [`sections ${JSON.stringify(labels)}`]),
      ...(summaries.some(line => !line.replace(/^【.+?】/, '').trim()) ? ['empty summary'] : []),
    ];
    const tooLong = summaries.filter(line => chars(line.replace(/^【.+?】/, '')) > LIMITS.line)
      .map(line => `版面行超过 ${LIMITS.line} 字：${line}`);
    const total = summaries.reduce((sum, line) => sum + chars(line), 0);
    if (total > LIMITS.total) tooLong.push(`全文 ${total} 字，超过 ${LIMITS.total} 字`);
    return { errors, tooLong, summaries };
  };
  // The model miscounts Chinese characters, so an overlong draft is sent back with the lines to shorten.
  let { result, text } = await ask();
  let checked = check(text);
  let retried = 0;
  // Weekly pages carry far more material, and one rewrite was not enough there (2026-11-09).
  while (!checked.errors.length && checked.tooLong.length && retried < 2) {
    retried += 1;
    messages.push({ role: 'assistant', content: text },
      { role: 'user', content: `以下内容太长，会被微信折叠。保留钩子，压缩字数后重写整条消息：\n${checked.tooLong.join('\n')}` });
    ({ result, text } = await ask());
    checked = check(text);
  }
  await writeFile(`${output}.response.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  if (checked.errors.length) throw new Error(`Invalid bot message: ${checked.errors.join('; ')}`);
  if (checked.tooLong.length) console.warn(`Bot message still long after ${retried} rewrites:\n${checked.tooLong.join('\n')}`);
  // Any line outside 【…】 (such as a hot line, dropped 2026-11-03) is discarded; code owns the layout.
  const body = [0, 1, 2].map(block => checked.summaries.filter((_, index) => blocks[index] === block))
    .filter(lines => lines.length).map(lines => lines.join('\n')).join('\n\n');
  const message = `${firstLine}\n${overviewUrl}\n\n${body}`;
  await writeFile(output, `${message}\n`, { mode: 0o600 });
  await writeFile(`${output}.run.json`, JSON.stringify({ model: result.model, elapsedMs: Date.now() - started,
    usage: result.usage, retried, stillLong: checked.tooLong, review: 'pending' }, null, 2), { mode: 0o600 });
  return message;
}
