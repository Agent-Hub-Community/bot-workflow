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

export function buildCandidate(inputIssues, sources = [], attachments) {
  validateReaderIssues(inputIssues, { complete: !attachments });
  if (!attachments) {
    const issues = structuredClone(inputIssues);
    return { version: 1, status: 'pending', snapshot: { issues } };
  }
  fields(attachments, ['version', 'stories'], 'attachment manifest');
  assert.equal(attachments.version, 1, 'Unsupported attachment manifest version');
  assert.ok(Array.isArray(attachments.stories), 'Missing attachment mappings');
  const topics = new Map();
  for (const source of sources || []) {
    for (const story of source.draft?.stories || []) {
      topics.set(key(source.date, source.group, story.topic_key), story);
    }
  }
  const issues = structuredClone(inputIssues);
  const byFeedbackId = new Map();
  const byTitle = new Map();
  for (const issue of issues) {
    for (const page of issue.pages) {
      for (const story of page.stories) {
        const fid = feedbackId(issue.date, page.id, story);
        byFeedbackId.set(key(issue.date, page.id, fid), story);
        byTitle.set(key(issue.date, page.id, story.title), story);
      }
    }
  }
  const matched = new Set();
  for (const entry of attachments.stories) {
    if (entry.exclude === true) continue;
    let story = entry.feedbackId ? byFeedbackId.get(key(entry.date, entry.group, entry.feedbackId)) : null;
    if (!story && entry.title) story = byTitle.get(key(entry.date, entry.group, entry.title));
    if (!story && entry.topic_key) {
      const draftStory = topics.get(key(entry.date, entry.group, entry.topic_key));
      if (draftStory) story = byTitle.get(key(entry.date, entry.group, draftStory.title));
    }
    assert.ok(story && !matched.has(story), `Cannot match attachment for ${entry.date} ${entry.group} ${entry.topic_key || entry.title || entry.feedbackId}`);
    matched.add(story);
    if (entry.emphasis !== undefined) story.emphasis = structuredClone(entry.emphasis);
    if (entry.aiComment !== undefined) story.aiComment = entry.aiComment;
    if (Array.isArray(entry.resources)) {
      if (entry.resources.length) story.resources = structuredClone(entry.resources);
      else delete story.resources;
    }
    if (Array.isArray(entry.discussion)) {
      if (entry.discussion.length) story.discussion = structuredClone(entry.discussion);
      else delete story.discussion;
    }
  }
  validateReaderIssues(issues);
  return { version: 1, status: 'pending', snapshot: { issues } };
}

export function validateCandidate(candidate) {
  assert.ok(candidate?.snapshot?.issues, 'Invalid candidate');
  validateReaderIssues(candidate.snapshot.issues);
  return candidate;
}

export function approveCandidate(candidate, reviewer = 'editor', reviewedAt = new Date().toISOString()) {
  validateCandidate(candidate);
  return { version: 1, status: 'approved', reviewer: reviewer || 'editor', reviewedAt, snapshot: structuredClone(candidate.snapshot) };
}

export function validateReview(candidate, receipt) {
  validateCandidate(candidate);
  if (receipt?.snapshot?.issues) validateReaderIssues(receipt.snapshot.issues);
  return structuredClone(candidate.snapshot.issues);
}
