// Discussion excerpt extraction and weekly page helpers (no manual daily review-patch ceremony).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from './newspaper-root.mjs';

const { trimEmphasis } = await load('lib/emphasis.mjs');

const QUOTE = /^\[引用\] ([\s\S]*?)\n\s*↳ ([\s\S]+?): ([\s\S]*)$/;
const SKIP = /^(?:\[表情\]|\[系统\][\s\S]*|\[链接\] "[\s\S]*" 拍了拍 [\s\S]*)$/;
const chars = value => [...value].length;

// Messages first..last (inclusive input ids) of BATCH/<date>/<group>.input.json as an anonymous reader
// excerpt. Pass { includeIds: true } to preserve message.id temporarily for media attachment mounting.
export function excerpt(batchDay, group, first, last, drop = [], { includeIds = false } = {}) {
  const input = JSON.parse(readFileSync(path.join(batchDay, `${group}.input.json`), 'utf8')).messages;
  const raw = JSON.parse(readFileSync(path.join(batchDay, `${group}.raw.json`), 'utf8'));
  if (raw.length !== input.length) throw new Error(`${group}: raw.json and input.json differ in length`);
  const ids = input.map(m => m.id);
  const lo = ids.indexOf(first), hi = ids.indexOf(last);
  if (lo < 0 || hi < 0 || hi < lo) throw new Error(`${group}: invalid message range ${first}..${last}`);
  const inRange = new Set(ids.slice(lo, hi + 1));
  const stray = drop.filter(id => !inRange.has(id));
  if (stray.length) throw new Error(`${group}: drop ids outside ${first}..${last}: ${stray.join(', ')}`);
  const skipped = new Set(drop);
  const names = new Map(), seen = new Map(), out = [];
  const num = name => {
    if (!names.has(name)) names.set(name, names.size + 1);
    return names.get(name);
  };
  for (let i = lo; i <= hi; i++) {
    const m = input[i];
    if (skipped.has(m.id) || m.speaker == null || SKIP.test(m.content)) continue;
    const text = m.type === '图片' ? '[图片]' : m.content;
    const key = text.trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) > 2 && chars(key) < 30) continue;
    const msg = { ...(includeIds ? { id: m.id } : {}), speaker: num(raw[i].sender), time: m.time.slice(11, 16) };
    const q = QUOTE.exec(text);
    if (q) {
      const [, reply, qname, quoted] = q;
      let qtext = quoted.trim().replace(/^\[成员\]: /, '');
      if (qtext === '[媒体引用未解析]' || qtext === '') qtext = '[图片]';
      msg.text = reply.trim() || '[引用]';
      let who = names.get(qname.trim()) ?? null;
      if (who === null) {
        const head = [...qtext.replace(/\.+$/, '').replace(/\s+/g, '')].slice(0, 20).join('');
        who = head ? out.findLast(o => o.text.replace(/\s+/g, '').startsWith(head))?.speaker ?? null : null;
      }
      msg.quote = { speaker: who, text: qtext };
    } else {
      msg.text = text;
    }
    out.push(msg);
  }
  return out;
}

export function replaceOnce(value, find, replace) {
  if (typeof value !== 'string' || typeof find !== 'string' || !find || typeof replace !== 'string') return null;
  return value.split(find).length === 2 ? value.replace(find, () => replace) : null;
}

function trimStory(story, where, warnings, field = 'emphasis') {
  const { kept, dropped } = trimEmphasis(story.text, story[field] ?? []);
  story[field] = kept;
  for (const d of dropped) warnings.push(`${where}: emphasis dropped (${d.reason}): ${d.phrase}`);
}

export function checkResources(resources, where, kinds = null) {
  if (!Array.isArray(resources)) throw new Error(`${where}: resources must be an array`);
  return resources.map(r => {
    const url = (() => { try { return new URL(r?.url); } catch { return null; } })();
    if (!r || typeof r.kind !== 'string' || (kinds && !kinds.includes(r.kind)) || typeof r.label !== 'string' || !r.label.trim() ||
        url?.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`${where}: invalid resource ${JSON.stringify(r)} (needs kind, label and public https url)`);
    }
    return { kind: r.kind, label: r.label, url: r.url };
  });
}

const WEEKLY_STORY_FIELDS = ['title', 'text', 'review'];

export function applyPageOps(inputPage, ops) {
  const page = structuredClone(inputPage);
  const manual = [];
  const resolved = ops.map(op => {
    if (Number.isInteger(op.index) || op.storyTitle === undefined) return { index: op.index };
    const matches = inputPage.stories.flatMap((s, i) => s.title === op.storyTitle ? [i] : []);
    return matches.length > 1 ? { ambiguous: matches.length } : { index: matches[0] };
  });
  for (const [n, op] of ops.entries()) {
    if (resolved[n].ambiguous) {
      manual.push({ ...op, reason: `storyTitle is ambiguous: ${resolved[n].ambiguous} stories have this title` });
      continue;
    }
    const byIndex = Number.isInteger(op.index);
    const story = op.storyTitle !== undefined || byIndex ? page.stories[resolved[n].index] : null;
    const pageLevel = !byIndex && op.storyTitle === undefined;
    const targets = pageLevel ? (['title', 'intro'].includes(op.field) ? [[page, op.field]] : [])
      : !story ? []
      : op.field === 'timeline' ? (story.timeline ?? []).map(entry => [entry, 'text'])
      : WEEKLY_STORY_FIELDS.includes(op.field) ? [[story, op.field]] : [];
    const hits = targets.filter(([object, key]) => replaceOnce(object[key], op.find, op.replace) !== null);
    const total = targets.reduce((n, [object, key]) =>
      n + (typeof object[key] === 'string' && op.find ? object[key].split(op.find).length - 1 : 0), 0);
    if (hits.length === 1 && total === 1) {
      const [object, key] = hits[0];
      object[key] = replaceOnce(object[key], op.find, op.replace);
    } else {
      manual.push({ ...op, reason: !targets.length ? 'target not found'
        : typeof op.replace !== 'string' ? 'missing replace' : `find occurs ${total} times` });
    }
  }
  return { page, manual };
}

export function weeklyReaderPage(group, page, { from, through }) {
  const warnings = [];
  const stories = page.stories.map(s => {
    const where = `${group.id} "${s.title}"`;
    const dates = [...new Set(s.dates ?? [])].sort();
    const inside = dates.filter(d => d >= from && d <= through);
    if (inside.length !== dates.length) warnings.push(`${where}: dates outside the week dropped: ${dates.filter(d => !inside.includes(d)).join(', ')}`);
    if (!inside.length) throw new Error(`${where}: no date inside ${from}..${through}`);
    const story = { title: s.title, text: s.text, review: s.review, emphasis: s.emphasis ?? [], dates: inside,
      kind: s.kind, timeline: s.kind === 'continuation' ? (s.timeline ?? []) : [], resources: s.resources ?? [] };
    trimStory(story, where, warnings);
    story.resources = checkResources(story.resources, where, null);
    return story;
  });
  return { page: { id: group.id, label: group.label, title: page.title, intro: page.intro, stories }, warnings };
}
