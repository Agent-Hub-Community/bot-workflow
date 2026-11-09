// Applies an editor's review to a daily batch (issues.json) or to reviewed weekly pages, so each issue
// no longer needs a hand-written edit script. Every change is data: a patch file for the daily edition,
// a page file plus optional find/replace ops for the weekly edition.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from './newspaper-root.mjs';

const { trimEmphasis } = await load('lib/emphasis.mjs');
const { validateStoryDiscussion } = await load('lib/story-discussion.mjs');
const { optionalPageGroups } = await load('lib/groups.mjs');

const QUOTE = /^\[引用\] ([\s\S]*?)\n\s*↳ ([\s\S]+?): ([\s\S]*)$/;
const SKIP = /^(?:\[表情\]|\[系统\][\s\S]*|\[链接\] "[\s\S]*" 拍了拍 [\s\S]*)$/;
// Length in code points, as editors count characters (an emoji is one).
const chars = value => [...value].length;

// Messages first..last (inclusive input ids) of BATCH/<date>/<group>.input.json as an anonymous reader
// excerpt. Members become 群友 N in order of first appearance, keyed by the sender in the parallel raw.json
// because quote headers name members by nickname. System messages and bare stickers are skipped, images
// read "[图片]", and a short message repeated as a chant keeps at most two copies.
export function excerpt(batchDay, group, first, last, drop = []) {
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
    const msg = { speaker: num(raw[i].sender), time: m.time.slice(11, 16) };
    const q = QUOTE.exec(text);
    if (q) {
      const [, reply, qname, quoted] = q;
      let qtext = quoted.trim().replace(/^\[成员\]: /, '');
      if (qtext === '[媒体引用未解析]' || qtext === '') qtext = '[图片]';
      msg.text = reply.trim() || '[引用]';
      let who = names.get(qname.trim()) ?? null;
      if (who === null) {
        // Quote headers show group nicknames, which may differ from the sender name; match the quoted text instead.
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

// Replaces the single occurrence of `find` in `value`. Returns the new string, or null when `find`
// occurs zero or several times, because a reviewer's quote must point at exactly one place.
export function replaceOnce(value, find, replace) {
  if (typeof value !== 'string' || typeof find !== 'string' || !find || typeof replace !== 'string') return null;
  return value.split(find).length === 2 ? value.replace(find, () => replace) : null;
}

// Daily readers accept these kinds only; weekly readers render any kind with a generic icon.
const DAILY_RESOURCE_KINDS = ['paper', 'article', 'code', 'demo', 'discussion'];
function checkResources(resources, where, kinds = DAILY_RESOURCE_KINDS) {
  if (!Array.isArray(resources)) throw new Error(`${where}: resources must be an array`);
  return resources.map(r => {
    const url = (() => { try { return new URL(r?.url); } catch { return null; } })();
    if (!r || typeof r.kind !== 'string' || (kinds && !kinds.includes(r.kind)) || typeof r.label !== 'string' || !r.label.trim() ||
        url?.protocol !== 'https:') {
      throw new Error(`${where}: invalid resource ${JSON.stringify(r)} (needs kind, label and https url)`);
    }
    // Daily resources go through finalize-batch, which rejects query strings and credentials (tracking
    // parameters, share tokens). Catch them here so the editor fixes the patch, not the last step (2026-11-09).
    if (kinds === DAILY_RESOURCE_KINDS && url.username + url.password + url.search) {
      throw new Error(`${where}: resource URL must not carry a query string or credentials: ${r.url}`);
    }
    return { kind: r.kind, label: r.label, url: r.url };
  });
}

function trimStory(story, where, warnings, field = 'emphasis') {
  const { kept, dropped } = trimEmphasis(story.text, story[field] ?? []);
  story[field] = kept;
  for (const d of dropped) warnings.push(`${where}: emphasis dropped (${d.reason}): ${d.phrase}`);
}

const DAILY_STORY_KEYS = ['index', 'new', 'remove', 'category', 'title', 'text', 'emphasis', 'aiComment',
  'replace', 'discussion', 'resources'];
const SET_FIELDS = ['category', 'title', 'text', 'emphasis', 'aiComment'];
const REPLACE_FIELDS = ['text', 'title', 'aiComment'];

/**
 * Applies a daily review patch to issues (as in BATCH/issues.json) and returns { issues, warnings };
 * the input is not modified. Patch format:
 *
 * { "date"?: "2026-11-01",                // needed only when issues holds several dates
 *   "pages": { "group-4": {
 *     "heading"?: "...", "theme"?: "...",
 *     "stories": [
 *       { "index": 0,                        // position before this patch; removals and additions apply last
 *         "title"?, "text"?, "emphasis"?, "aiComment"?, "category"?,   // replace the whole field
 *         "replace"?: [{ "field": "text|title|aiComment", "find": "verbatim, unique", "replace": "new" }],
 *         "discussion"?: { "first": "m0001", "last": "m0020", "drop"?: ["m0005"] },
 *         "resources"?: [{ "kind": "paper|article|code|demo|discussion", "label": "...", "url": "https://..." }],
 *         "remove"?: true },
 *       { "new": true, "category", "title", "text", "emphasis", "aiComment", "discussion"?, "resources"? } ] } } }
 *
 * A `find` that is missing or not unique in its field is an error; all such errors are reported together.
 * After the edits each touched story's emphasis is trimmed to spans validateEmphasis accepts; the dropped
 * spans become warnings. Discussion ranges are cut from BATCH/<date>/<group>.input.json and raw.json.
 */
export function applyDailyPatch(inputIssues, patch, { batchDir }) {
  const extra = Object.keys(patch).filter(key => !['date', 'pages'].includes(key));
  if (extra.length) throw new Error(`Unknown patch field ${extra.join(', ')}`);
  const issues = structuredClone(inputIssues);
  const issue = patch.date ? issues.find(i => i.date === patch.date) : issues.length === 1 ? issues[0] : null;
  if (!issue) throw new Error(patch.date ? `No issue for ${patch.date}` : 'Patch needs "date": issues.json holds several dates');
  const errors = [], warnings = [];
  const discussion = (group, spec, where) => {
    if (!spec?.first || !spec?.last) throw new Error(`${where}: discussion needs first and last`);
    const messages = excerpt(path.join(batchDir, issue.date), group, spec.first, spec.last, spec.drop ?? []);
    validateStoryDiscussion(messages);
    return messages;
  };
  for (const [group, edit] of Object.entries(patch.pages ?? {})) {
    const page = issue.pages.find(p => p.id === group);
    if (!page) throw new Error(`No page ${group} on ${issue.date}`);
    for (const key of Object.keys(edit)) {
      if (!['heading', 'theme', 'note', 'stories'].includes(key)) throw new Error(`${group}: unknown page field ${key}`);
    }
    for (const key of ['heading', 'theme', 'note']) if (edit[key] !== undefined) page[key] = edit[key];
    const removed = new Set(), added = [], touched = new Set();
    for (const op of edit.stories ?? []) {
      const unknown = Object.keys(op).filter(key => !DAILY_STORY_KEYS.includes(key));
      if (unknown.length) throw new Error(`${group}: unknown story field ${unknown.join(', ')}`);
      if (op.new) {
        const where = `${group} new "${op.title}"`;
        for (const key of ['category', 'title', 'text']) {
          if (typeof op[key] !== 'string' || !op[key].trim()) throw new Error(`${where}: missing ${key}`);
        }
        const story = { category: op.category, title: op.title, text: op.text, emphasis: op.emphasis ?? [],
          aiComment: op.aiComment ?? '' };
        if (op.discussion) story.discussion = discussion(group, op.discussion, where);
        if (op.resources) story.resources = checkResources(op.resources, where);
        trimStory(story, where, warnings);
        added.push(story);
        continue;
      }
      const story = page.stories[op.index];
      if (!Number.isInteger(op.index) || !story) throw new Error(`${group}: no story at index ${op.index}`);
      if (touched.has(op.index)) throw new Error(`${group}: story ${op.index} edited twice`);
      touched.add(op.index);
      const where = `${group}[${op.index}]`;
      if (op.remove) {
        const other = Object.keys(op).filter(key => !['index', 'remove'].includes(key));
        if (other.length) throw new Error(`${where}: remove cannot be combined with ${other.join(', ')}`);
        removed.add(story);
        continue;
      }
      for (const key of SET_FIELDS) if (op[key] !== undefined) story[key] = op[key];
      for (const r of op.replace ?? []) {
        if (!REPLACE_FIELDS.includes(r.field)) { errors.push(`${where}: cannot replace field ${r.field}`); continue; }
        const next = replaceOnce(story[r.field], r.find, r.replace);
        if (next === null) {
          const count = typeof r.find === 'string' && r.find && typeof story[r.field] === 'string'
            ? story[r.field].split(r.find).length - 1 : 0;
          errors.push(`${where}.${r.field}: find occurs ${count} times: ${r.find}`);
        } else story[r.field] = next;
      }
      if (op.discussion) story.discussion = discussion(group, op.discussion, where);
      if (op.resources) {
        if (op.resources.length) story.resources = checkResources(op.resources, where);
        else delete story.resources;
      }
      trimStory(story, where, warnings);
    }
    page.stories = page.stories.filter(s => !removed.has(s)).concat(added);
  }
  if (errors.length) throw new Error(`Review patch not applied:\n${errors.join('\n')}`);
  // A topical group only appears when it has stories (optionalPageGroups); when review removes its last
  // story the whole page goes, because the draft-edition check rejects an empty optional page (2026-11-09).
  const optional = new Set(optionalPageGroups(issue.date).map(group => group.id));
  issue.pages = issue.pages.filter(page => {
    if (!optional.has(page.id) || page.stories?.length) return true;
    warnings.push(`${page.id}: every story removed; the page is left out`);
    return false;
  });
  return { issues, warnings };
}

/**
 * Merges several daily review patches into one patch per issue date, so that patches written by
 * different editors (one per group, say) apply together instead of each starting over. `patches` is a
 * list of { name, patch }. A patch without "date" means the only issue in `issues`. Two patches that
 * edit the same story index, or set the same page field, of one group are a conflict and an error.
 * Returns [{ date, pages }] in the order dates first appear.
 */
export function mergeDailyPatches(issues, patches) {
  const byDate = new Map(), owners = new Map();
  for (const { name, patch } of patches) {
    const extra = Object.keys(patch).filter(key => !['date', 'pages'].includes(key));
    if (extra.length) throw new Error(`${name}: unknown patch field ${extra.join(', ')}`);
    const date = patch.date ?? (issues.length === 1 ? issues[0].date : null);
    if (!date) throw new Error(`${name}: patch needs "date": issues.json holds several dates`);
    if (!byDate.has(date)) byDate.set(date, { date, pages: {} });
    const merged = byDate.get(date).pages;
    for (const [group, edit] of Object.entries(patch.pages ?? {})) {
      const target = merged[group] ??= {};
      const claim = (key, label) => {
        const id = `${date} ${group} ${key}`;
        if (owners.has(id)) {
          const by = owners.get(id) === name ? `twice in ${name}` : `by both ${owners.get(id)} and ${name}`;
          throw new Error(`${date} ${group}: ${label} edited ${by}`);
        }
        owners.set(id, name);
      };
      for (const [key, value] of Object.entries(edit)) {
        if (key === 'stories') continue;
        claim(key, key);
        target[key] = value;
      }
      for (const op of edit.stories ?? []) {
        if (!op.new) claim(`#${op.index}`, `story ${op.index}`);
        (target.stories ??= []).push(op);
      }
    }
  }
  return [...byDate.values()];
}

// Applies several patches (see mergeDailyPatches) at once and returns { issues, warnings }.
export function applyDailyPatches(inputIssues, patches, options) {
  let issues = inputIssues;
  const warnings = [];
  for (const patch of mergeDailyPatches(inputIssues, patches)) {
    const result = applyDailyPatch(issues, patch, options);
    issues = result.issues;
    warnings.push(...result.warnings);
  }
  return { issues, warnings };
}

const WEEKLY_STORY_FIELDS = ['title', 'text', 'review'];

// Applies a reviewer's find/replace ops to a weekly page ({title, intro, stories}). An op names a story by
// storyTitle or index; without either it edits the page title or intro. field "timeline" searches all of
// the story's timeline entries. Ops that do not resolve to exactly one place are returned as manual.
// Titles are resolved against the page as given, before any op runs, so an op that retitles a story
// does not change which story a later op reaches; a title shared by several stories is ambiguous.
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

// A reader page from a reviewed weekly page: only reader fields, emphasis trimmed to valid spans,
// dates kept inside from..through, and a timeline only for continuing stories.
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
