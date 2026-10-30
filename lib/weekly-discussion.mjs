const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const groupPattern = /^group-\d+$/;
const speakerPattern = /^p[1-9]\d*$/;
const fail = message => { throw new Error(message); };
const norm = value => value.replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkDate(date) {
  if (!datePattern.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('Invalid message date');
}
function messageIndex(id) {
  const index = /^m\d+$/.test(id) ? Number(id.slice(1)) : NaN;
  if (!Number.isSafeInteger(index) || index < 1) fail('Invalid message id');
  return index;
}
function refParts(ref) {
  const match = /^(\d{4}-\d{2}-\d{2}):(m\d+)$/.exec(ref);
  if (!match) fail('Invalid message ref');
  checkDate(match[1]);
  return [match[1], messageIndex(match[2])];
}
export function compareRefs(a, b) {
  const [aDate, aIndex] = refParts(a), [bDate, bIndex] = refParts(b);
  return aDate.localeCompare(bDate) || aIndex - bIndex;
}

// A daily pN is an identity only within this date, group and single input source.
export function namespaceInput(input, date, group) {
  checkDate(date);
  if (!groupPattern.test(group) || input?.date !== date || input?.group?.id !== group ||
      !Array.isArray(input.messages)) fail('Input date/group mismatch');
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length !== 1)) {
    fail('Expected one source per group/date');
  }
  const ids = new Set();
  return { ...input, messages: input.messages.map(message => {
    const index = messageIndex(message.id);
    if (ids.has(index)) fail(`Duplicate message ref in ${date}/${group}`);
    ids.add(index);
    if (message.date !== undefined && message.date !== date) fail('Message date mismatch');
    if (message.ref !== undefined && message.ref !== `${date}:${message.id}`) fail('Message ref mismatch');
    if (message.time !== undefined && !message.time.startsWith(`${date} `) && !message.time.startsWith(`${date}T`)) {
      fail('Message time/date mismatch');
    }
    if (typeof message.content !== 'string') fail('Missing message content');
    let speaker = message.speaker ?? null;
    if (speaker !== null) {
      const prefix = `${date}/${group}/`;
      if (typeof speaker !== 'string') fail('Invalid speaker');
      if (speaker.startsWith(prefix) && speakerPattern.test(speaker.slice(prefix.length))) {
        // Already normalized; retain the original namespace.
      } else if (speakerPattern.test(speaker)) speaker = prefix + speaker;
      else fail('Speaker namespace mismatch');
    }
    return { ...message, speaker };
  }) };
}

function messageContent(message) {
  return message.type === '图片' || /^\[图片\]/.test(message.content) ? '[图片]' : message.content;
}
export function modelMessages(input, date, group, modelInput) {
  if (typeof modelInput !== 'function') fail('modelMessages requires the newspaper modelInput');
  return modelInput(namespaceInput(input, date, group)).messages.map(message => ({
    date, id: message.id, time: message.time, speaker: message.speaker,
    type: message.type, content: message.content,
  }));
}
export function evidenceMessages(input, date, group) {
  return namespaceInput(input, date, group).messages
    .filter(m => m.content && !m.content.startsWith('[系统]') && !/^\[链接\] "/.test(m.content) && m.content.trim() !== '[表情]')
    .map(m => ({ ref: `${date}:${m.id}`, t: m.time?.slice(11) ?? '', s: m.speaker,
      c: (m.content + (m.image?.description ? ` [图片：${m.image.description.slice(0, 120)}]` : '')).slice(0, 600) }));
}

// sanitizeInput must be the same sanitizer used by the daily collector.
export function prepareMessages(days, { sanitizeInput } = {}) {
  if (typeof sanitizeInput !== 'function') fail('prepareMessages requires the daily sanitizeInput');
  const seenDays = new Set(), groups = new Set(), messages = [];
  for (const { date, group, input, raw } of days) {
    const key = `${date}/${group}`;
    if (seenDays.has(key)) fail('Multiple sources for one group/date');
    seenDays.add(key); groups.add(group);
    if (groups.size > 1) fail('prepareMessages accepts one group at a time');
    const normalized = namespaceInput(input, date, group);
    if (!Array.isArray(raw) || raw.length !== normalized.messages.length) fail(`Raw/input count mismatch ${key}`);
    const sanitized = sanitizeInput({ messages: raw }).messages;
    const senders = new Map();
    normalized.messages.forEach((message, index) => {
      const source = raw[index];
      if (typeof source.time !== 'string' || typeof source.type !== 'string' || typeof source.content !== 'string' ||
          source.time !== message.time || source.type !== message.type || sanitized[index]?.content !== message.content) {
        fail(`Raw/input alignment mismatch ${key} at ${index}`);
      }
      const rawSender = source.sender || null;
      if ((rawSender !== null && typeof rawSender !== 'string') || Boolean(rawSender) !== Boolean(message.speaker)) {
        fail(`Raw/input sender mismatch ${key} at ${index}`);
      }
      if (message.speaker) {
        if (senders.has(message.speaker) && senders.get(message.speaker) !== rawSender) fail(`Inconsistent daily speaker ${key}`);
        senders.set(message.speaker, rawSender);
      }
      messages.push({ ...message, date, group, ref: `${date}:${message.id}`, rawSender });
    });
  }
  return messages.sort((a, b) => compareRefs(a.ref, b.ref));
}

const unescapeQuote = value => value.replace(/&#x20;/gi, ' ').replace(/&#x0A;/gi, '\n').replace(/&amp;/g, '&');
export function quoteOf(content) {
  const match = /^\[引用\]\s*([\s\S]*?)(?:\n\s*| {2,})↳\s*([^:\n：]+)[:：]\s*([\s\S]*)$/.exec(content);
  return match ? { body: match[1].trim(), sender: match[2].trim(), text: unescapeQuote(match[3]).trim() } : null;
}
const bodyOf = message => quoteOf(messageContent(message))?.body ?? messageContent(message);
const mediaQuote = text => /^\[(?:图片|媒体引用|表情|视频|语音)|^\[成员\]:\s*\[(?:图片|媒体引用|表情|视频|语音)/.test(text);

function matchesQuotedBody(target, text) {
  const body = norm(bodyOf(target)), full = norm(messageContent(target));
  if (!body || mediaQuote(body)) return false;
  const stripped = norm(text.replace(/^\[引用\]\s*/, ''));
  const truncated = /(?:\.{3}|…|\[\.\.\.\])\s*$/.test(stripped);
  const prefix = truncated ? stripped.replace(/(?:\[\.\.\.\]|\.{3}|…)\s*$/, '').trim() : stripped;
  if (truncated && prefix.length < 20) return false;
  if (truncated ? (body.startsWith(prefix) || full.startsWith(prefix)) : (body === stripped || full === stripped)) return true;
  if (stripped.startsWith('[链接]') && full.startsWith(stripped.split(' URL:')[0].trim())) return true;
  return false;
}

export function resolveQuoteTarget(message, messages) {
  const quote = quoteOf(messageContent(message));
  if (!quote) return null;
  const text = norm(quote.text);
  if (!text || mediaQuote(text)) return null;
  const earlier = messages.filter(target => target.speaker && compareRefs(target.ref, message.ref) < 0);
  const bySender = earlier.filter(target => target.rawSender === quote.sender && matchesQuotedBody(target, text));
  if (bySender.length === 1) return bySender[0];
  if (earlier.some(target => target.rawSender === quote.sender)) return null;
  // When raw.json senders are wxid_* identifiers instead of display names, match by unique earlier text.
  if (!earlier.some(target => /^wxid_/.test(target.rawSender || ''))) return null;
  const byText = earlier.filter(target => matchesQuotedBody(target, text));
  return byText.length === 1 ? byText[0] : null;
}

const english = name => /^[A-Za-z0-9 _-]+$/.test(name);
const nameKey = name => english(name) ? name.toLowerCase() : name;
function anonymizer(messages, people, allNames) {
  const names = [...new Set([...allNames, ...messages.flatMap(m => [m.rawSender, quoteOf(m.content)?.sender]).filter(Boolean)])]
    .filter(name => typeof name === 'string' && name.trim()).sort((a, b) => b.length - a.length);
  const owners = new Map();
  for (const message of messages) if (message.rawSender && message.speaker) {
    const key = `${message.date}/${nameKey(message.rawSender)}`;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(message.speaker);
  }
  const pattern = names.length ? new RegExp(names.map(name => english(name)
    ? `(?<![A-Za-z0-9_-])${escape(name)}(?![A-Za-z0-9_-])` : escape(name)).join('|'), 'gi') : null;
  return (text, date = null) => {
    if (!pattern) return text.trim();
    // Daily sanitization has already checked URLs. Keep public links intact while masking prose.
    return text.split(/(https?:\/\/[^\s<>"'，。]+)/gi).map((part, index) => index % 2 ? part : part.replace(pattern, name => {
      const speakers = date ? owners.get(`${date}/${nameKey(name)}`) : null;
      const number = speakers?.size === 1 ? people.get([...speakers][0]) : null;
      return number ? `群友 ${number}` : '群友';
    })).join('').trim();
  };
}

// Exclusions are applied before expanding replies or quote targets. Raw identities stay in audit only.
export function buildDiscussion(messages, refs, { allNames = [], excludedRefs = [], removeQuoteRefs = [], maskNames = false } = {}) {
  const all = [...messages].sort((a, b) => compareRefs(a.ref, b.ref));
  const lookup = new Map(all.map(m => [m.ref, m]));
  if (lookup.size !== all.length || all.some((m, i) => i && compareRefs(all[i - 1].ref, m.ref) === 0)) fail('Duplicate message ref');
  const excluded = new Set(excludedRefs), removeQuote = new Set(removeQuoteRefs);
  const eligible = m => m?.speaker && m.type !== '系统' && !excluded.has(m.ref);
  for (const ref of refs) if (!lookup.has(ref)) fail('Unknown evidence ref');
  const selected = new Set(refs.filter(ref => eligible(lookup.get(ref))));
  const targets = new Map(all.map(m => [m.ref, resolveQuoteTarget(m, all)]));
  // Expand only replies to the original evidence, then include their known earlier targets.
  const base = new Set(selected);
  for (const message of all) if (eligible(message) && !removeQuote.has(message.ref) && base.has(targets.get(message.ref)?.ref)) selected.add(message.ref);
  for (const ref of selected) {
    if (removeQuote.has(ref)) continue;
    const target = targets.get(ref);
    if (eligible(target)) selected.add(target.ref);
  }
  const rows = all.filter(m => selected.has(m.ref));
  const people = new Map();
  for (const row of rows) if (!people.has(row.speaker)) people.set(row.speaker, people.size + 1);
  const clean = maskNames ? anonymizer(all, people, allNames) : text => text.trim(), audit = [];
  const discussion = rows.map((message, discussionIndex) => {
    const quote = quoteOf(messageContent(message)), target = targets.get(message.ref);
    const speaker = people.get(message.speaker);
    const entry = { speaker, time: `${message.date.slice(5, 7)}.${message.date.slice(8)} ${message.time.slice(11, 16)}`,
      text: clean(quote ? quote.body : messageContent(message), message.date) || '[图片]' };
    if (quote && quote.text && !removeQuote.has(message.ref) && !excluded.has(target?.ref)) {
      entry.quote = { speaker: target && selected.has(target.ref) ? people.get(target.speaker) : null,
        text: clean(quote.text, target?.date ?? null) };
    }
    entry.continues = false;
    audit.push({ discussionIndex, ref: message.ref, sourceSpeaker: message.speaker, speaker,
      quoteTarget: target?.ref ?? null, quoteSpeaker: entry.quote?.speaker ?? null });
    return entry;
  });
  return { discussion, audit };
}

export function validateDiscussionAudit(discussion, audit) {
  if (!Array.isArray(audit) || audit.length !== discussion.length) fail('Discussion/audit length mismatch');
  const refs = new Set(), people = new Map(), numbers = new Map();
  audit.forEach((row, index) => {
    if (!row || row.discussionIndex !== index || row.speaker !== discussion[index].speaker) fail('Discussion/audit alignment mismatch');
    const [date] = refParts(row.ref);
    const source = /^(\d{4}-\d{2}-\d{2})\/(group-\d+)\/(p[1-9]\d*)$/.exec(row.sourceSpeaker);
    if (!source || source[1] !== date || (row.page !== undefined && row.page !== source[2]) || refs.has(row.ref)) fail('Invalid audit source identity');
    refs.add(row.ref);
    if ((people.has(row.sourceSpeaker) && people.get(row.sourceSpeaker) !== row.speaker) ||
        (numbers.has(row.speaker) && numbers.get(row.speaker) !== row.sourceSpeaker)) fail('Audit speaker collision');
    people.set(row.sourceSpeaker, row.speaker); numbers.set(row.speaker, row.sourceSpeaker);
    if (row.quoteTarget !== null && compareRefs(row.quoteTarget, row.ref) >= 0) fail('Audit quote target is not earlier');
    if (row.quoteSpeaker !== null && (!Number.isInteger(row.quoteSpeaker) || row.quoteSpeaker < 1)) fail('Invalid audit quote speaker');
  });
  return audit;
}

// Filtering never renumbers or adds messages. Missing audit cannot establish a quote's source.
export function selectDiscussion(discussion, keep, audit = null) {
  if (!Array.isArray(keep) || keep.some(n => !Number.isInteger(n) || n < 0 || n >= discussion.length)) fail('Invalid selection index');
  if (audit !== null) validateDiscussionAudit(discussion, audit);
  const indices = [...new Set(keep)].sort((a, b) => a - b);
  const retained = new Map(audit ? indices.map(n => [audit[n].ref, n]) : []);
  const selected = indices.map(n => {
    const message = discussion[n];
    const entry = { speaker: message.speaker, time: message.time, text: message.text, continues: false };
    if (message.quote) {
      const target = audit ? retained.get(audit[n].quoteTarget) : undefined;
      const speaker = target !== undefined && target < n && audit[target].speaker === audit[n].quoteSpeaker ? audit[target].speaker : null;
      entry.quote = { speaker, text: message.quote.text };
    }
    return entry;
  });
  return { discussion: selected, audit: audit === null ? null : indices.map((n, discussionIndex) => ({
    ...audit[n], discussionIndex,
  })) };
}
