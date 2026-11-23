// Pure deterministic helpers for daily and weekly WeChat group guide messages (zero external LLM API calls).
// Antigravity writes the message directly from bot-input.json; checkBotMessage validates format, segments and sections.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LIMITS = { segment: 1200, total: 2200 };

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

export function botSections(pages) {
  const withStories = pages.filter(page => page.stories?.length);
  const owners = new Map();
  for (const page of withStories) for (const story of page.stories) {
    for (const key of new Set((story.resources || story.links || []).map(r => linkKey(r.url)).filter(Boolean))) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(page.label);
    }
  }
  const alsoIn = (story, page) => {
    const others = new Set();
    for (const r of story.resources || story.links || []) {
      for (const label of owners.get(linkKey(r.url)) || []) if (label !== page.label) others.add(label);
    }
    return others.size ? { alsoIn: [...others] } : {};
  };
  const sections = withStories.map(page => ({
    id: page.id,
    label: page.label,
    heading: page.heading ?? page.title,
    theme: page.theme ?? page.intro,
    stories: page.stories.map(story => ({
      title: story.title,
      highlights: story.emphasis || [],
      comment: story.aiComment || story.review || '',
      ...alsoIn(story, page),
    })),
  }));
  // Main groups (group-1..5, group-9), topical groups (group-6..8), and external news form separate blocks.
  const topical = new Set(['group-6', 'group-7', 'group-8']);
  const blocks = withStories.map(page => page.id === 'external' ? 2 : topical.has(page.id) ? 1 : 0);
  return { sections, blocks };
}

function readSpecialTheme(date, newspaperDir) {
  if (!newspaperDir || !date) return null;
  try {
    const configPath = path.join(newspaperDir, 'site/skins/config.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const skinId = config?.editions?.[date];
    if (!skinId) return null;
    const themePath = path.join(newspaperDir, 'site/skins', skinId, 'theme.json');
    if (!existsSync(themePath)) return { id: skinId };
    const theme = JSON.parse(readFileSync(themePath, 'utf8'));
    return {
      id: skinId,
      kind: theme.kind || 'special',
      name: theme.name || skinId,
      label: theme.masthead?.label || theme.name || skinId,
      message: theme.masthead?.message || theme.summary || '',
    };
  } catch { return null; }
}

export function buildDailyBotInput(issue, { date, site = 'https://agent-hub-community.github.io/newspaper', preview = true, newspaperDir = process.env.NEWSPAPER_DIR } = {}) {
  const cleanSite = site.replace(/\/$/, '');
  const firstLine = `AgentHub ${date.replaceAll('-', '.')} 日报${preview ? '导览（链接待上线核验）' : '已上线'}`;
  const overviewUrl = `${cleanSite}/daily/${date}/overview/`;
  const { sections, blocks } = botSections(issue.pages || []);
  const specialTheme = readSpecialTheme(date, newspaperDir);
  return { date, firstLine, overviewUrl, ...(specialTheme ? { specialTheme } : {}), sections, blocks };
}

const chars = line => [...line].length;

export function checkBotMessage(text, { firstLine, overviewUrl, sections, blocks }) {
  const trimmed = text.trim();
  const rawSegments = trimmed.split(/\n\s*---+\s*\n/).map(s => s.trim()).filter(Boolean);
  const errors = [];
  const warnings = [];
  if (!rawSegments.length) errors.push('empty bot message');
  if (/\*\*|```|^#/m.test(trimmed)) errors.push('Markdown markup not allowed in WeChat message');

  const isMulti = rawSegments.length > 1;
  const foundLabels = [];
  let total = 0;

  for (let i = 0; i < rawSegments.length; i += 1) {
    const seg = rawSegments[i];
    const lines = seg.split('\n');
    const head = (lines[0] || '').trim();
    const expectedHeadPrefix = firstLine;
    if (!head.startsWith(expectedHeadPrefix)) {
      errors.push(`segment ${i + 1} first line must start with: ${expectedHeadPrefix}`);
    }
    const links = seg.match(/https?:\/\/[^\s]+/g) || [];
    if (JSON.stringify(links) !== JSON.stringify([overviewUrl])) {
      errors.push(`segment ${i + 1} expected single link ${overviewUrl}, got ${JSON.stringify(links)}`);
    }
    const bodyLines = lines.slice(1).filter(l => l.trim() !== overviewUrl);
    const segChars = chars(bodyLines.join('\n').trim());
    total += segChars;
    if (segChars > LIMITS.segment) {
      warnings.push(`第 ${i + 1} 段正文 ${segChars} 字，超过建议上限 ${LIMITS.segment} 字，可考虑拆段`);
    }
    for (let li = 0; li < lines.length; li += 1) {
      const m = lines[li].trim().match(/^【(.+?)】(.*)$/);
      if (!m) continue;
      const label = m[1];
      if (label.startsWith('特刊聚焦')) continue;
      foundLabels.push(label);
      const inlineBody = m[2].trim();
      const nextLine = (lines[li + 1] || '').trim();
      if (!inlineBody && (!nextLine || nextLine.startsWith('【'))) {
        errors.push(`empty section: 【${label}】`);
      }
    }
  }

  const expectedLabels = sections.map(section => section.label);
  if (JSON.stringify(foundLabels) !== JSON.stringify(expectedLabels)) {
    errors.push(`sections mismatch: expected ${JSON.stringify(expectedLabels)}, got ${JSON.stringify(foundLabels)}`);
  }
  if (total > LIMITS.total) warnings.push(`全文 ${total} 字，超过建议上限 ${LIMITS.total} 字`);

  // Preserve rich multi-line bulleted or multi-segment layout; only normalize legacy single-line format.
  const isRich = isMulti || /^•\s/m.test(trimmed) || /^【特刊聚焦/m.test(trimmed);
  let formatted;
  if (isRich) {
    formatted = `${rawSegments.join('\n\n---\n\n')}\n`;
  } else {
    const summaries = trimmed.split('\n').map(line => line.trim()).filter(line => line.startsWith('【'));
    const body = [0, 1, 2]
      .map(block => summaries.filter((_, index) => blocks[index] === block))
      .filter(lines => lines.length)
      .map(lines => lines.join('\n'))
      .join('\n\n');
    formatted = `${firstLine}\n${overviewUrl}\n\n${body}\n`;
  }
  return { ok: errors.length === 0, errors, warnings, formatted, total, segments: rawSegments.length };
}
