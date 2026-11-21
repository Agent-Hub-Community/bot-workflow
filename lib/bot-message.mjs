// Pure deterministic helpers for daily and weekly WeChat group guide messages (zero external LLM API calls).
// Antigravity writes the message directly from bot-input.json; checkBotMessage validates format and block spacing.

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
  // Main groups, topic groups (group-6+), and external news form separate blocks.
  const blocks = withStories.map(page => page.id === 'external' ? 2 : Number(page.id?.match(/^group-(\d+)$/)?.[1]) >= 6 ? 1 : 0);
  return { sections, blocks };
}

export function buildDailyBotInput(issue, { date, site = 'https://agent-hub-community.github.io/newspaper', preview = true } = {}) {
  const cleanSite = site.replace(/\/$/, '');
  const firstLine = `AgentHub ${date.replaceAll('-', '.')} 日报${preview ? '导览（链接待上线核验）' : '已上线'}`;
  const overviewUrl = `${cleanSite}/daily/${date}/overview/`;
  const { sections, blocks } = botSections(issue.pages || []);
  return { date, firstLine, overviewUrl, sections, blocks };
}

const chars = line => [...line].length;

export function checkBotMessage(text, { firstLine, overviewUrl, sections, blocks }) {
  const trimmed = text.trim();
  const summaries = trimmed.split('\n').map(line => line.trim()).filter(line => line.startsWith('【'));
  const links = trimmed.match(/https?:\/\/[^\s]+/g) || [];
  const labels = summaries.map(line => line.match(/^【(.+?)】/)?.[1]);
  const expectedLabels = sections.map(section => section.label);
  const errors = [
    ...(trimmed.startsWith(firstLine) ? [] : [`first line must start with: ${firstLine}`]),
    ...(/\*\*|```|^#/m.test(trimmed) ? ['Markdown markup not allowed in WeChat message'] : []),
    ...(JSON.stringify(links) === JSON.stringify([overviewUrl]) ? [] : [`expected single link ${overviewUrl}, got ${JSON.stringify(links)}`]),
    ...(JSON.stringify(labels) === JSON.stringify(expectedLabels) ? [] : [`sections mismatch: expected ${JSON.stringify(expectedLabels)}, got ${JSON.stringify(labels)}`]),
    ...(summaries.some(line => !line.replace(/^【.+?】/, '').trim()) ? ['empty summary line'] : []),
  ];
  const warnings = summaries
    .filter(line => chars(line.replace(/^【.+?】/, '')) > LIMITS.line)
    .map(line => `版面行超过 ${LIMITS.line} 字：${line}`);
  const total = summaries.reduce((sum, line) => sum + chars(line), 0);
  if (total > LIMITS.total) warnings.push(`全文 ${total} 字，超过 ${LIMITS.total} 字`);
  const body = [0, 1, 2]
    .map(block => summaries.filter((_, index) => blocks[index] === block))
    .filter(lines => lines.length)
    .map(lines => lines.join('\n'))
    .join('\n\n');
  const formatted = `${firstLine}\n${overviewUrl}\n\n${body}\n`;
  return { ok: errors.length === 0, errors, warnings, formatted, total };
}
