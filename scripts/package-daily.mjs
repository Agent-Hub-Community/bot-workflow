// Packages Antigravity-authored group drafts (BATCH/<date>/<group>.draft.json) into BATCH/issues.json,
// automatically mounts discussion excerpts + static media attachments (images, video/audio/file cards),
// trims invalid emphasis spans gracefully, and emits BATCH/bot-input.json for the WeChat guide message.
//   node "$BOT/scripts/package-daily.mjs" YYYY-MM-DD BATCH_DIR [--external EXTERNAL_DIR]
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from '../lib/newspaper-root.mjs';
import { excerpt } from '../lib/review-patch.mjs';
import { buildDailyBotInput } from '../lib/bot-message.mjs';

const { pageGroups, optionalPageGroups } = await load('lib/groups.mjs');
const { trimEmphasis } = await load('lib/emphasis.mjs');
const { validateStoryDiscussion } = await load('lib/story-discussion.mjs');
const { mergeExternalEditions } = await load('lib/external-editions.mjs');
const { readerReport } = await load('lib/external-workflow.mjs');
const { site: publicSite } = await load('lib/site.mjs');

const DAILY_RESOURCE_KINDS = new Set(['paper', 'article', 'code', 'demo', 'discussion']);

const optionalJson = async file => readFile(file, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

function fileLabel(text) {
  const match = /^\[文件\]\s*(.+?)\s*\(([^,()]+),/.exec(text || '');
  return match ? { name: match[1], detail: match[2] } : null;
}

function sanitizeResources(resources, where, warnings) {
  if (!Array.isArray(resources) || !resources.length) return undefined;
  const kept = [];
  for (const r of resources) {
    try {
      const url = new URL(r?.url);
      if (url.protocol !== 'https:' || url.username || url.password) {
        warnings.push(`${where}: dropped non-public resource URL ${r?.url}`);
        continue;
      }
      const kind = DAILY_RESOURCE_KINDS.has(r?.kind) ? r.kind : 'article';
      const label = typeof r?.label === 'string' && r.label.trim() ? r.label.trim() : url.hostname;
      kept.push({ kind, label, url: r.url });
    } catch {
      warnings.push(`${where}: dropped invalid resource ${JSON.stringify(r)}`);
    }
  }
  return kept.length ? kept : undefined;
}

async function attachMedia({ date, batch, group, input, draftStory, readerStory, imageAlts }) {
  const dayDir = path.join(batch, date);
  if (!existsSync(path.join(dayDir, `${group}.raw.json`))) return;
  let first, last, drop = [];
  if (draftStory.discussion_range?.first && draftStory.discussion_range?.last) {
    ({ first, last, drop = [] } = draftStory.discussion_range);
  } else {
    const ids = Array.isArray(draftStory.evidence_ids) ? draftStory.evidence_ids : [];
    if (!ids.length) return;
    const valid = ids.filter(id => input.messages.some(m => m.id === id));
    if (!valid.length) return;
    first = valid[0];
    last = valid.at(-1);
  }
  const discussions = excerpt(dayDir, group, first, last, drop, { includeIds: true });
  const media = await optionalJson(path.join(dayDir, `${group}.media.json`))
    || await optionalJson(path.join(dayDir, `${group}.images.json`)) || [];
  const byId = new Map(media.map(record => [record.id, record]));

  async function stageFile(sourceRel, bucket, name) {
    const relative = path.posix.join('attachments', bucket, name);
    const destination = path.join(batch, relative);
    if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.join(dayDir, sourceRel), destination);
    }
    return relative;
  }

  const indexById = new Map(discussions.map((message, idx) => [message.id, idx + 1]));

  for (const message of discussions) {
    const record = byId.get(message.id);
    const text = message.text.trim();
    const kind = record?.kind || (record?.file && text === '[图片]' ? 'image' : null);
    if (kind === 'image' && record?.file) {
      const targetName = record.md5 ? `${record.md5}.${record.format}` : `${date}-${group}-${message.id}.${record.format}`;
      const relative = await stageFile(record.file, 'media', targetName);
      const alt = imageAlts?.[message.id] || record.description || '群聊图片';
      message.attachments = [{
        kind: 'image', src: relative, alt: String(alt).slice(0, 240),
        ...(record.width && record.height ? { width: record.width, height: record.height } : {}),
      }];
    } else if (kind === 'video' && (record?.file || record?.poster)) {
      const posterExt = record.posterFormat || path.extname(record.poster || '').slice(1) || 'jpg';
      const poster = record.poster
        ? await stageFile(record.poster, 'media', `${record.posterMd5 || `${date}-${group}-${message.id}-poster`}.${posterExt}`)
        : undefined;
      if (record.file) {
        const relative = await stageFile(record.file, 'media', `${record.md5 || `${date}-${group}-${message.id}`}.mp4`);
        message.attachments = [{ kind: 'video', src: relative, mime: 'video/mp4', ...(poster ? { poster } : {}), ...(record.bytes ? { bytes: record.bytes } : {}) }];
      } else {
        message.attachments = [{ kind: 'video', poster, label: '视频' }];
      }
    } else if (kind === 'file' && record?.file) {
      const relative = await stageFile(record.file, 'files', `${record.md5 || `${date}-${group}-${message.id}`}.${record.format}`);
      message.attachments = [{ kind: 'file', href: relative, name: record.name, ...(record.bytes ? { bytes: record.bytes } : {}) }];
    } else if (text === '[图片]') {
      message.attachments = [{ kind: 'image', label: '图片' }];
    } else if (text === '[视频]') {
      message.attachments = [{ kind: 'video', label: '视频' }];
    } else if (text === '[语音]') {
      message.attachments = [{ kind: 'audio', label: '语音' }];
    } else {
      const file = fileLabel(text);
      if (file) message.attachments = [{ kind: 'file', name: file.name, label: file.detail }];
    }
    delete message.id;
  }
  validateStoryDiscussion(discussions);
  readerStory.discussion = discussions;
  if (Array.isArray(draftStory.points) && draftStory.points.length) {
    const mapped = draftStory.points.flatMap(point => {
      const text = typeof point === 'string' ? point.trim() : typeof point?.text === 'string' ? point.text.trim() : '';
      if (!text) return [];
      const rawRefs = Array.isArray(point?.refs) ? point.refs : [];
      const refs = [...new Set(rawRefs.map(ref => typeof ref === 'number' ? ref : indexById.get(ref))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= discussions.length))].sort((a, b) => a - b);
      return [{ text, ...(refs.length ? { refs } : {}) }];
    });
    if (mapped.length) readerStory.points = mapped;
  }
}

export async function packageDaily({ date, batch: batchArg, external: externalArg, site = publicSite, log = console.log } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !batchArg) {
    throw new Error('Usage: package-daily.mjs YYYY-MM-DD BATCH_DIR [--external EXTERNAL_DIR]');
  }
  const batch = path.resolve(batchArg);
  const dayDir = path.join(batch, date);
  const required = pageGroups(date);
  const optional = optionalPageGroups ? optionalPageGroups(date) : [];
  const optionalIds = new Set(optional.map(g => g.id));
  const pages = [];
  const warnings = [];

  for (const group of [...required, ...optional]) {
    const input = await optionalJson(path.join(dayDir, `${group.id}.input.json`));
    if (!input) {
      if (optionalIds.has(group.id)) continue;
      throw new Error(`Missing ${path.join(dayDir, `${group.id}.input.json`)}`);
    }
    const draft = await optionalJson(path.join(dayDir, `${group.id}.draft.json`));
    const cutoffMs = Date.parse(input.cutoff);
    const cutoffDay = new Date(cutoffMs + 8 * 3600_000).toISOString().slice(0, 10);
    const time = new Date(cutoffMs).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
    const baseNote = input.coverage.completeDay
      ? `${date} · 当日本地记录`
      : cutoffDay !== date
        ? `${date} · 截至北京时间 ${cutoffDay.slice(5)} ${time}`
        : `${date} · 截至北京时间 ${time}`;

    if (!input.coverage.count || !draft || !Array.isArray(draft.stories) || !draft.stories.length) {
      if (optionalIds.has(group.id)) continue;
      pages.push({
        id: group.id, label: group.label, section: '今日讨论',
        heading: draft?.heading?.trim() || '本日暂无可读记录',
        theme: typeof draft?.theme === 'string' ? draft.theme.trim() : '',
        note: input.coverage.count ? baseNote : `${baseNote} · 无本地可读记录`,
        stories: [],
      });
      continue;
    }

    if (typeof draft.heading !== 'string' || !draft.heading.trim()) {
      throw new Error(`${group.id}: draft missing heading`);
    }
    const seenTitles = new Set();
    const stories = [];
    for (const [index, rawStory] of draft.stories.entries()) {
      const where = `${group.id}[${index}]`;
      for (const field of ['category', 'title', 'text', 'aiComment']) {
        if (typeof rawStory?.[field] !== 'string' || !rawStory[field].trim()) {
          throw new Error(`${where}: missing ${field}`);
        }
      }
      if (seenTitles.has(rawStory.title)) throw new Error(`${where}: duplicate title "${rawStory.title}"`);
      seenTitles.add(rawStory.title);

      const { kept, dropped } = trimEmphasis(rawStory.text, Array.isArray(rawStory.emphasis) ? rawStory.emphasis : []);
      for (const d of dropped) warnings.push(`${where}: emphasis dropped (${d.reason}): ${d.phrase}`);

      const resources = sanitizeResources(rawStory.resources, where, warnings);
      const tldr = typeof rawStory.tldr === 'string' && rawStory.tldr.trim() ? rawStory.tldr.trim() : undefined;
      const fallbackPoints = Array.isArray(rawStory.points) && rawStory.points.length
        ? rawStory.points.flatMap(point => {
            const text = typeof point === 'string' ? point.trim() : typeof point?.text === 'string' ? point.text.trim() : '';
            return text ? [{ text }] : [];
          })
        : [];
      const story = {
        category: rawStory.category.trim(),
        title: rawStory.title.trim(),
        ...(tldr ? { tldr } : {}),
        ...(fallbackPoints.length ? { points: fallbackPoints } : {}),
        text: rawStory.text.trim(),
        emphasis: kept,
        aiComment: rawStory.aiComment.trim(),
        ...(resources ? { resources } : {}),
      };
      if (Array.isArray(rawStory.discussion) && rawStory.discussion.length) {
        validateStoryDiscussion(rawStory.discussion);
        story.discussion = rawStory.discussion;
      } else {
        await attachMedia({
          date, batch, group: group.id, input, draftStory: rawStory, readerStory: story,
          imageAlts: draft.image_alts || {},
        });
      }
      stories.push(story);
    }

    pages.push({
      id: group.id,
      label: group.label,
      section: '今日讨论',
      heading: draft.heading.trim(),
      theme: typeof draft.theme === 'string' ? draft.theme.trim() : '',
      note: baseNote,
      stories,
    });
  }

  const issues = [{ id: date, date, label: `${date} 日报`, pages }];
  if (/aeskey/.test(JSON.stringify(issues))) throw new Error('aeskey leaked into issues.json');
  await writeFile(path.join(batch, 'issues.json'), JSON.stringify(issues, null, 2) + '\n', { mode: 0o600 });

  // Build bot-input.json (including external page if reviewed-final.json exists).
  let combinedIssue = issues[0];
  if (externalArg) {
    const extDraft = await optionalJson(path.join(path.resolve(externalArg), 'reviewed-final.json'));
    const extSelection = await optionalJson(path.join(path.resolve(externalArg), 'selection.json'));
    if (extDraft) {
      combinedIssue = mergeExternalEditions(issues, [readerReport(extDraft, extSelection)]).find(item => item.date === date) || issues[0];
    }
  }
  const botInput = buildDailyBotInput(combinedIssue, { date, site, preview: true });
  await writeFile(path.join(batch, 'bot-input.json'), JSON.stringify(botInput, null, 2) + '\n', { mode: 0o600 });

  for (const w of warnings) console.warn(`warning: ${w}`);
  log(`Packaged ${date}: ${pages.map(p => `${p.id}:${p.stories.length}`).join(' ')}`);
  return { issues, botInput, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const extIdx = args.indexOf('--external');
  const external = extIdx >= 0 ? args.splice(extIdx, 2)[1] : undefined;
  await packageDaily({ date: args[0], batch: args[1], external });
}
