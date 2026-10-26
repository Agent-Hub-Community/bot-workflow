import assert from 'node:assert/strict';
import { load } from './newspaper-root.mjs';
import { extractLinks } from '../scripts/package-month-resources.mjs';

const { feedbackId } = await load('lib/feedback-id.mjs');
const { validateDraft } = await load('lib/daily-generation.mjs');
const { mergeDraftEditions } = await load('lib/draft-editions.mjs');
const { pageGroups } = await load('lib/groups.mjs');
const { validateEmphasis } = await load('lib/emphasis.mjs');
const { validateStoryDiscussion } = await load('lib/story-discussion.mjs');
const { commentStories, validateComments } = await load('lib/story-comments.mjs');
const { cleanText, safeUrl } = await load('lib/content.mjs');
const { validateDate } = await load('lib/external-workflow.mjs');

function fields(value, allowed, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  assert.ok(Object.keys(value).every(key => allowed.includes(key)), `Unexpected ${label} field`);
}
function text(value, label, empty = false) {
  assert.equal(typeof value, 'string', `Missing ${label}`);
  assert.ok(empty || value.trim(), `Empty ${label}`);
}
const key = (date, group, topic) => JSON.stringify([date, group, topic]);
const urlIdentity = value => {
  try { return new URL(value).href; } catch { return null; }
};

function readerText(value) {
  if (typeof value === 'string') {
    assert.equal(cleanText(value), value.trim(), 'Private material in reader copy');
    assert.doesNotMatch(value, /aeskey|wxid_|@chatroom|xsec_token|\/Users\/|(?:^|\s)\/(?:home|tmp)\//i,
      'Private material in reader copy');
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'，。]+/g)) {
      const url = match[0];
      assert.ok(safeUrl(url) && new URL(url).href === safeUrl(url), 'Unsafe reader URL');
    }
  } else if (Array.isArray(value)) value.forEach(readerText);
  else if (value && typeof value === 'object') Object.values(value).forEach(readerText);
}

// These allowlists cover only the daily group batch. The external-news workflow has its own review.
export function validateReaderIssues(issues, { complete = true } = {}) {
  mergeDraftEditions([], issues);
  for (const issue of issues) {
    fields(issue, ['id', 'date', 'label', 'pages'], 'issue');
    validateDate(issue.date);
    text(issue.label, 'issue label');
    assert.deepEqual(issue.pages.map(page => page.id), pageGroups(issue.date).map(group => group.id),
      `Missing or unexpected reader group on ${issue.date}`);
    for (const page of issue.pages) {
      fields(page, ['id', 'label', 'section', 'heading', 'theme', 'note', 'stories'], 'page');
      for (const name of ['label', 'section', 'heading', 'theme', 'note']) text(page[name], `page ${name}`, name === 'theme');
      const ids = new Set();
      for (const story of page.stories) {
        fields(story, ['category', 'title', 'text', 'emphasis', 'aiComment', 'resources', 'discussion'], 'story');
        for (const name of ['category', 'title', 'text']) text(story[name], `story ${name}`);
        const id = feedbackId(issue.date, page.id, story);
        assert.ok(!ids.has(id), 'Duplicate current feedbackId');
        ids.add(id);
        // The manifest replaces old emphasis after an editorial body change.
        if (complete) validateEmphasis(story.text, story.emphasis);
        validateStoryDiscussion(story.discussion);
        if (story.resources !== undefined) {
          assert.ok(Array.isArray(story.resources), 'Invalid resources');
          for (const resource of story.resources) {
            fields(resource, ['kind', 'label', 'url'], 'resource');
            assert.ok(['paper', 'article', 'code', 'demo', 'discussion'].includes(resource.kind),
              'Unsupported reader resource kind');
            text(resource.label, 'resource label');
            const url = new URL(resource.url);
            assert.equal(url.protocol, 'https:', 'Expected public HTTPS resource URL');
            assert.equal(url.username + url.password + url.search, '', 'Unsafe resource URL');
          }
        }
      }
    }
  }
  readerText(issues);
  if (complete) {
    const stories = commentStories(issues);
    validateComments(issues.flatMap(issue => issue.pages.flatMap(page => page.stories.map(story => ({
      id: feedbackId(issue.date, page.id, story), comment: story.aiComment,
    })))), stories);
  }
  return issues;
}

export function buildCandidate(inputIssues, sources, attachments) {
  validateReaderIssues(inputIssues, { complete: false });
  fields(attachments, ['version', 'stories'], 'attachment manifest');
  assert.equal(attachments.version, 1, 'Unsupported attachment manifest version');
  assert.ok(Array.isArray(attachments.stories), 'Missing attachment mappings');
  assert.ok(Array.isArray(sources), 'Missing source snapshots');
  const expectedSources = new Set(inputIssues.flatMap(issue => issue.pages.map(page => key(issue.date, page.id))));
  const topics = new Map();
  for (const source of sources) {
    fields(source, ['date', 'group', 'input', 'draft'], 'source');
    assert.ok(expectedSources.delete(key(source.date, source.group)), 'Unknown or duplicate source');
    assert.equal(source.input.date, source.date, 'Wrong input date');
    assert.equal(source.input.group?.id, source.group, 'Wrong input group');
    assert.ok(Array.isArray(source.input.messages), 'Missing input evidence');
    assert.equal(new Set(source.input.messages.map(message => message.id)).size, source.input.messages.length,
      'Duplicate input evidence ID');
    for (const message of source.input.messages) text(message.id, 'evidence ID');
    validateDraft(source.draft, source.input);
    for (const story of source.draft.stories) {
      const id = key(source.date, source.group, story.topic_key);
      assert.ok(!topics.has(id), 'Duplicate source topic_key');
      topics.set(id, { story, input: source.input });
    }
  }
  assert.equal(expectedSources.size, 0, 'Missing source snapshots');
  const issues = structuredClone(inputIssues);
  const current = new Map(issues.flatMap(issue => issue.pages.flatMap(page => page.stories.map(story => [
    key(issue.date, page.id, feedbackId(issue.date, page.id, story)), story,
  ]))));
  for (const entry of attachments.stories) {
    fields(entry, entry.exclude === true
      ? ['date', 'group', 'topic_key', 'exclude', 'reason']
      : ['date', 'group', 'topic_key', 'feedbackId', 'resources', 'resourceEvidence', 'discussion', 'emphasis', 'aiComment'], 'attachment');
    const topicId = key(entry.date, entry.group, entry.topic_key);
    const source = topics.get(topicId);
    assert.ok(source, 'Unknown, stale or duplicate topic mapping');
    topics.delete(topicId);
    if (entry.exclude === true) {
      text(entry.reason, 'exclusion reason');
      continue;
    }
    assert.match(entry.feedbackId || '', /^[a-f0-9]{32}$/, 'Missing current feedbackId');
    const currentId = key(entry.date, entry.group, entry.feedbackId);
    const story = current.get(currentId);
    assert.ok(story, 'Stale or duplicate current feedbackId; update the explicit topic mapping');
    current.delete(currentId);
    assert.ok(Array.isArray(entry.resources), 'Missing resources decision (use [])');
    assert.ok(Array.isArray(entry.discussion), 'Missing discussion decision (use [])');
    assert.ok(Array.isArray(entry.emphasis), 'Missing emphasis decision (use [])');
    text(entry.aiComment, 'AI comment');
    // Canonical links need an explicit verification record when they differ from source links.
    const evidence = source.input.messages.filter(message => source.story.evidence_ids.includes(message.id));
    const urls = new Set(evidence.flatMap(message => extractLinks(message.content)
      .map(link => urlIdentity(link.url))).filter(Boolean));
    const verified = new Map();
    assert.ok(entry.resourceEvidence === undefined || Array.isArray(entry.resourceEvidence), 'Invalid resource evidence');
    for (const record of entry.resourceEvidence || []) {
      fields(record, ['url', 'sourceUrl', 'reviewer', 'reviewedAt', 'basis'], 'resource evidence');
      assert.ok(safeUrl(record.url) && !verified.has(record.url), 'Invalid or duplicate resource evidence URL');
      assert.ok(safeUrl(record.sourceUrl) && urls.has(urlIdentity(record.sourceUrl)), 'Resource source URL missing from topic evidence');
      text(record.reviewer, 'resource reviewer');
      text(record.basis, 'resource verification basis');
      assert.ok(Number.isFinite(Date.parse(record.reviewedAt)), 'Missing resource verification timestamp');
      verified.set(record.url, record);
    }
    const usedResources = new Set();
    for (const resource of entry.resources) {
      assert.ok(!usedResources.has(resource.url), 'Duplicate resource URL');
      usedResources.add(resource.url);
      assert.ok((safeUrl(resource.url) && urls.has(urlIdentity(resource.url))) || verified.has(resource.url),
        'Resource missing from topic evidence or explicit resource verification');
      verified.delete(resource.url);
    }
    assert.equal(verified.size, 0, 'Stale resource verification');
    Object.assign(story, { emphasis: structuredClone(entry.emphasis), aiComment: entry.aiComment });
    if (entry.resources.length) story.resources = structuredClone(entry.resources);
    else delete story.resources;
    if (entry.discussion.length) story.discussion = structuredClone(entry.discussion);
    else delete story.discussion;
  }
  assert.equal(topics.size, 0, 'Missing attachment or explicit exclusion for source topic');
  assert.equal(current.size, 0, 'Missing attachment mapping for current story');
  validateReaderIssues(issues);
  return { version: 1, status: 'pending', snapshot: structuredClone({ inputIssues, sources, attachments, issues }) };
}

export function validateCandidate(candidate) {
  fields(candidate, ['version', 'status', 'snapshot'], 'candidate');
  assert.equal(candidate.version, 1);
  assert.equal(candidate.status, 'pending', 'Expected pending candidate');
  fields(candidate.snapshot, ['inputIssues', 'sources', 'attachments', 'issues'], 'snapshot');
  const { inputIssues, sources, attachments } = candidate.snapshot;
  assert.deepEqual(candidate, buildCandidate(inputIssues, sources, attachments), 'Candidate snapshot is inconsistent');
  return candidate;
}

export function approveCandidate(candidate, reviewer, reviewedAt = new Date().toISOString()) {
  validateCandidate(candidate);
  text(reviewer, 'reviewer');
  assert.ok(Number.isFinite(Date.parse(reviewedAt)), 'Missing review timestamp');
  return { version: 1, status: 'approved', reviewer, reviewedAt, snapshot: structuredClone(candidate.snapshot) };
}

export function validateReview(candidate, receipt) {
  validateCandidate(candidate);
  fields(receipt, ['version', 'status', 'reviewer', 'reviewedAt', 'snapshot'], 'review receipt');
  assert.equal(receipt.version, 1);
  assert.equal(receipt.status, 'approved', 'Editorial approval required');
  text(receipt.reviewer, 'reviewer');
  assert.ok(Number.isFinite(Date.parse(receipt.reviewedAt)), 'Missing review timestamp');
  assert.deepEqual(receipt.snapshot, candidate.snapshot, 'Full snapshot changed after review; review the new candidate');
  return structuredClone(candidate.snapshot.issues);
}
