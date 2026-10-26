import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

export function parseData(source) {
  const match = source.match(/^window\.AGENT_HUB_DATA = ([\s\S]+);\s*$/);
  assert.ok(match, 'Unexpected data.js format; inspect current build format');
  return JSON.parse(match[1]);
}

// The groups that have a reader section on `date`, from the newspaper checkout's lib/groups.mjs.
// Historical issues keep the coverage they had, because lib/groups.mjs records when each section started.
export async function pageGroupIds(newspaper, date) {
  const { pageGroups } = await import(pathToFileURL(path.join(path.resolve(newspaper), 'lib/groups.mjs')).href);
  assert.equal(typeof pageGroups, 'function', 'lib/groups.mjs must export pageGroups(date)');
  const ids = pageGroups(date).map(group => group.id);
  assert.ok(ids.length, `No group has a reader section on ${date}`);
  return ids;
}

export function checkEdition(data, date, { groups, rankThrough = date }) {
  for (const value of [date, rankThrough]) {
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10), value);
  }
  assert.ok(Array.isArray(groups) && groups.length, 'Expected the edition\'s group ids');
  assert.equal(data.publicBuild, true, 'Expected approved public build');
  const issues = data.digests.filter(issue => issue.date === date);
  assert.equal(issues.length, 1, 'Target edition missing or duplicated');
  const issue = issues[0];
  assert.deepEqual(issue.pages.map(p => p.id).sort(), ['external', ...groups].sort());
  const counts = Object.fromEntries(issue.pages.map(p => {
    assert.ok(Array.isArray(p.stories), `Missing stories for ${p.id}`);
    for (const story of p.stories) {
      for (const field of ['title', 'text', 'aiComment']) assert.ok(story[field]?.trim(), `Missing ${field}`);
      assert.match(story.feedbackId, /^[a-f0-9]{32}$/);
    }
    return [p.id, p.stories.length];
  }));
  assert.ok(Object.values(counts).some(n => n > 0), 'Entire edition is empty');
  assert.ok(rankThrough >= date, 'Community rankings cannot predate edition');
  for (const period of ['week', 'month', 'all']) {
    assert.equal(data.activity.windows[period].through, rankThrough, `${period} ranking cutoff mismatch`);
  }
  for (const id of groups) {
    const group = data.activity.groups.find(g => g.id === id);
    assert.ok(group?.daily?.[date], `Missing ${id} daily ranking`);
  }
  return counts;
}

export async function verify({ newspaper, site, date, rankThrough = date, out }) {
  const base = new URL(site);
  assert.ok(['https:', 'http:'].includes(base.protocol));
  assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname.endsWith('/'),
    'Site must be a directory URL without credentials, query or hash');
  const output = path.resolve(out);
  const dataOutput = `${output}.data.json`;
  for (const file of [output, dataOutput]) {
    let exists = false;
    try { await access(file); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(!exists, `Preserve previous evidence; choose a new --out: ${file}`);
  }
  const root = path.resolve(newspaper);
  const require = createRequire(path.join(root, 'package.json'));
  const { parseHTML } = require('linkedom');
  const { validatePublicActivity } = await import(pathToFileURL(path.join(root, 'lib/public-activity.mjs')));
  const expected = await readFile(path.join(root, 'dist/data.js'), 'utf8');
  const get = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert.equal(response.status, 200, `Unexpected HTTP status: ${url}`);
    return response.text();
  };
  const { document } = parseHTML(await get(base));
  const scripts = [...document.querySelectorAll('script[src]')].map(n => new URL(n.getAttribute('src'), base));
  const candidates = scripts.filter(u => u.origin === base.origin && u.pathname === `${base.pathname}data.js`);
  assert.equal(candidates.length, 1, 'Expected one same-site root data.js reference');
  const source = await get(candidates[0]);
  assert.equal(source === expected, true, 'Live data differs from dist/data.js; check deployment SHA and cache');
  const data = parseData(source);
  // data.js is an index; each issue's pages ship as issues/<date>.js. Older builds inline the pages.
  const index = data.digests.find(issue => issue.date === date);
  let issueUrl = null, issueSha256 = null;
  if (index?.version) {
    const relative = `issues/${date}.js`;
    const local = await readFile(path.join(root, 'dist', relative), 'utf8');
    issueUrl = new URL(`${relative}?v=${index.version}`, base);
    const live = await get(issueUrl);
    assert.equal(live === local, true, `Live ${relative} differs from dist/${relative}; check deployment SHA and cache`);
    const head = `(window.AGENT_HUB_ISSUES = window.AGENT_HUB_ISSUES || {})[${JSON.stringify(date)}] = `;
    assert.ok(live.startsWith(head), 'Unexpected issue script format; inspect current build format');
    index.pages = JSON.parse(live.slice(head.length).replace(/;\s*$/, '')).pages;
    issueSha256 = createHash('sha256').update(live).digest('hex');
  }
  const counts = checkEdition(data, date, { groups: await pageGroupIds(root, date), rankThrough });
  validatePublicActivity(data.activity, data.digests);
  const receipt = {
    verifiedAt: new Date().toISOString(), site: base.href, date, rankThrough,
    dataUrl: candidates[0].href, sha256: createHash('sha256').update(source).digest('hex'),
    issueUrl: issueUrl?.href || null, issueSha256,
    exactDataMatch: true, counts, dataFile: dataOutput, browserVerified: false, botSent: false,
  };
  await writeFile(dataOutput, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(output, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      newspaper: { type: 'string' }, site: { type: 'string' }, date: { type: 'string' },
      'rank-through': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('node verify-publication.mjs --newspaper PATH --site URL/ --date YYYY-MM-DD --out NEW_FILE [--rank-through YYYY-MM-DD]');
    } else {
      for (const key of ['newspaper', 'site', 'date', 'out']) assert.ok(values[key], `Missing --${key}`);
      console.log(JSON.stringify(await verify({ ...values, rankThrough: values['rank-through'] || values.date }), null, 2));
    }
  } catch (error) {
    console.error(`Publication verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
