// Prepares one daily edition with a single command: collects chats and images, collects external candidates,
// drafts and packages the group pages, adds comments/headlines/emphasis, and prepares the activity board.
//   node "$BOT/scripts/daily.mjs" prepare YYYY-MM-DD [--batch DIR] [--external DIR] [--from-step STEP[,STEP]] [--dry-run]
//   node "$BOT/scripts/daily.mjs" finish  YYYY-MM-DD --batch DIR --external DIR [--reports DIR] [--dry-run]
// `finish` runs everything after the editors' review in one go: applies BATCH/review/*.patch.json, validates the
// batch, drafts and comments the external page from EXTERNAL/selection.json, builds the local preview and writes
// the group-message draft to REPORTS/<date>-AgentHub导览草稿.md. Steps whose output already exists are skipped, so
// after fixing a patch or the external page it is enough to delete the stale output and run finish again.
//   node "$BOT/scripts/daily.mjs" publish YYYY-MM-DD --batch DIR --external DIR [--reports DIR] [--dry-run]
// `publish` releases a finished edition: newspaper's release.mjs, a commit of data/ pushed to main, the deploy
// run, the read-back check of the live site, and the reviewed group-message draft retitled as published. It needs
// the newspaper checkout on a clean main and the release environment (config/daily-env.sh).
// The chat steps run one after another; each reads the previous step's output, and running them in sequence also
// keeps the three WeChat-database steps from overlapping. collect-external reads no database and runs beside them.
// A collect-external failure only warns, so the chat pages still get prepared. Each step writes its output to
// BATCH/logs/<step>.log. When a chat step fails the script stops the chat steps and prints the --from-step command
// that resumes at that step.
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, rootDir } from '../lib/newspaper-root.mjs';

const botDir = fileURLToPath(new URL('../', import.meta.url));

// The edition plan: `main` lists the chat steps in the order they run; `external` runs beside them.
// `wechat` marks steps that open the WeChat databases; `llm` marks steps that call the model.
export function buildPlan({ date, batch, external, bot = botDir }) {
  const pipeline = path.join(bot, 'pipeline'), scripts = path.join(bot, 'scripts');
  return {
    main: [
      { name: 'collect-batch', wechat: true, llm: false,
        args: [path.join(pipeline, 'collect-batch.mjs'), date, date, batch] },
      { name: 'collect-images', wechat: true, llm: true,
        args: [path.join(pipeline, 'collect-images.mjs'), date, batch] },
      // --resume keeps drafts that already pass validation, so a rerun only redrafts the groups that failed.
      { name: 'generate', wechat: false, llm: true,
        args: [path.join(scripts, 'prepare-week-d.mjs'), 'generate', date, date, batch, '--emphasis', '--resume'] },
      { name: 'package', wechat: false, llm: false,
        args: [path.join(scripts, 'prepare-week-d.mjs'), 'package', date, date, batch, '--emphasis'] },
      // enrich-month-d.mjs rewrites issues.json, which prepare-release-activity.mjs reads.
      { name: 'enrich', wechat: false, llm: true,
        args: [path.join(scripts, 'enrich-month-d.mjs'), batch] },
      { name: 'release-activity', wechat: true, llm: false,
        args: [path.join(pipeline, 'prepare-release-activity.mjs'), batch] },
    ],
    external: { name: 'collect-external', wechat: false, llm: false,
      args: [path.join(scripts, 'collect-external.mjs'), date, external] },
  };
}

const stepsOf = ({ main, external }) => [...main, ...(external ? [external] : [])];

// Selects the steps of a resumed run: the chat steps from the earliest named one onward, and collect-external
// only when it is named. No names keeps the whole plan.
export function selectSteps(plan, fromSteps = []) {
  if (!fromSteps.length) return plan;
  const known = stepsOf(plan).map(step => step.name);
  const unknown = fromSteps.filter(name => !known.includes(name));
  if (unknown.length) throw new Error(`Unknown step ${unknown.join(', ')}; steps are ${known.join(', ')}`);
  const first = plan.main.findIndex(step => fromSteps.includes(step.name));
  return {
    main: first < 0 ? [] : plan.main.slice(first),
    external: fromSteps.includes(plan.external.name) ? plan.external : null,
  };
}

// Runs the chat steps one at a time, stopping at the first failure, while collect-external runs beside them.
// runStep(step) resolves when the step succeeds and rejects when it fails. `resume` is the first unfinished chat
// step, or null when they all finished.
export async function runPlan({ main, external }, runStep) {
  const externalRun = external
    ? Promise.resolve().then(() => runStep(external)).then(() => null, error => error)
    : Promise.resolve(null);
  const done = [];
  let failed = null;
  for (const step of main) {
    try {
      await runStep(step);
      done.push(step.name);
    } catch (error) {
      failed = { name: step.name, error };
      break;
    }
  }
  const externalError = await externalRun;
  return { done, failed, resume: failed?.name ?? null, externalFailed: externalError ? { error: externalError } : null };
}

// The first run number N for which neither day-D-runN nor external-D-runN exists among the scratch entries.
export function nextRun(entries, date) {
  const taken = new Set(entries);
  let run = 1;
  while (taken.has(`day-${date}-run${run}`) || taken.has(`external-${date}-run${run}`)) run += 1;
  return run;
}

// Resolves the batch and external directories. Fresh runs default to the next free run under scratch/;
// a resumed run (--from-step) must name the batch it continues, because a new directory has nothing to resume.
export function resolveDirs({ date, batch, external, fromSteps = [], scratch, entries }) {
  if (fromSteps.length && !batch) throw new Error('--from-step continues an existing batch; pass --batch DIR');
  const run = nextRun(entries, date);
  // A batch named day-D-runN pairs with external-D-runN beside it, so a resumed run finds its external page.
  const paired = batch && path.basename(path.resolve(batch)).match(/^day-(\d{4}-\d{2}-\d{2}-run\d+)$/);
  return {
    batch: path.resolve(batch || path.join(scratch, `day-${date}-run${run}`)),
    external: path.resolve(external || (paired ? path.join(path.dirname(path.resolve(batch)), `external-${paired[1]}`)
      : path.join(scratch, `external-${date}-run${run}`))),
  };
}

// Environment variables the selected steps need, so a missing one stops the run before it reads any database.
export function missingEnv(selected, env) {
  const steps = stepsOf(selected);
  const names = [
    ...(steps.some(step => step.wechat) ? ['WX_ACTIVITY_HOME'] : []),
    ...(steps.some(step => step.llm) ? ['DAILY_LLM_BASE_URL', 'DAILY_LLM_MODEL', 'DAILY_LLM_API_KEY'] : []),
  ];
  return names.filter(name => !env[name]);
}

// One line per collected group with its message count; empty or missing groups are flagged, since an empty
// group can mean a quiet day or a client that has not synchronized.
export function formatCounts(rows) {
  const lines = rows.map(({ label, id, count }) => count === null
    ? `  !! ${label} (${id}): 没有 raw.json，采集没跑完`
    : count === 0 ? `  !! ${label} (${id}): 0 条，核实是当天没人说话还是客户端未同步`
      : `     ${label} (${id}): ${count} 条`);
  const empty = rows.filter(row => !row.count).length;
  return [`各群条数：`, ...lines, ...(empty ? [`!! ${empty} 个群为 0 条或缺失，发布前逐一核实同步情况。`] : [])];
}

async function groupCounts(date, batch) {
  const { collectedGroups } = await load('lib/groups.mjs');
  return Promise.all(collectedGroups(date).map(async ({ id, label }) => {
    try {
      const raw = JSON.parse(await readFile(path.join(batch, date, `${id}.raw.json`), 'utf8'));
      return { id, label, count: raw.length };
    } catch (error) {
      if (error.code === 'ENOENT') return { id, label, count: null };
      throw error;
    }
  }));
}

// New leaderboard avatars must be looked at by hand; publishing waits until avatar-review.json has no pending entry.

// The steps after review. `has(file)` reports whether a file exists; it decides which steps still need to run.
// The external page is regenerated only when its draft is missing, and reviewed-final.json falls back to the
// commented draft: the external review only fixes errors, and on most days it changes nothing.
export function buildFinishPlan({ date, batch, external, reports, patches = [], has, bot = botDir, newspaper = rootDir }) {
  const scripts = path.join(bot, 'scripts');
  const draft = path.join(external, 'draft.json'), commented = path.join(external, 'commented-draft.json');
  const selection = path.join(external, 'selection.json'), final = path.join(external, 'reviewed-final.json');
  const withExternal = has(selection);
  const steps = [];
  if (patches.length) steps.push({ name: 'apply-review', args: [path.join(scripts, 'apply-review.mjs'), batch, ...patches] });
  steps.push({ name: 'finalize-batch', args: [path.join(scripts, 'finalize-batch.mjs'), batch] });
  if (withExternal && !has(draft)) {
    steps.push({ name: 'generate-external', llm: true, args: [path.join(scripts, 'generate-external.mjs'), selection, draft] });
  }
  if (withExternal && !has(commented)) {
    steps.push({ name: 'external-comments', llm: true,
      args: [path.join(scripts, 'generate-external-comments.mjs'), draft, commented] });
  }
  if (withExternal && !has(final)) steps.push({ name: 'external-final', copy: [commented, final] });
  steps.push({ name: 'preview', args: [path.join(newspaper, 'scripts/prepare-preview.mjs'), '--date', date, '--batch', batch,
    ...(withExternal ? ['--external-draft', final, '--external-selection', selection] : [])] });
  const botMd = path.join(batch, 'bot-preview.md');
  steps.push({ name: 'bot', llm: true,
    args: [path.join(scripts, 'generate-bot.mjs'), path.join(batch, 'final-reader-issue.json'), date, botMd, '--preview'] });
  steps.push({ name: 'report', copy: [botMd, path.join(reports, `${date}-AgentHub导览草稿.md`)] });
  return steps;
}

export async function finish(options, { env = process.env, run = execute, log = console.log } = {}) {
  const { date } = options;
  if (!options.batch || !options.external) throw new Error('finish needs --batch DIR and --external DIR');
  const batch = path.resolve(options.batch), external = path.resolve(options.external);
  const reports = path.resolve(options.reports || path.join(rootDir, '..', 'reports'));
  const reviewDir = path.join(batch, 'review');
  const patches = existsSync(reviewDir)
    ? (await readdir(reviewDir)).filter(name => name.endsWith('.patch.json')).sort().map(name => path.join(reviewDir, name)) : [];
  const steps = buildFinishPlan({ date, batch, external, reports, patches, has: existsSync });
  log(`收尾（依次）：${steps.map(step => step.name).join(' -> ')}`);
  if (!patches.length) log('!! review/ 下没有审稿补丁，按模型初稿收尾');
  const missing = steps.some(step => step.llm)
    ? ['DAILY_LLM_BASE_URL', 'DAILY_LLM_MODEL', 'DAILY_LLM_API_KEY'].filter(name => !env[name]) : [];
  if (missing.length) throw new Error(`Set ${missing.join(', ')} before finishing the edition (see the runbook)`);
  if (options.dryRun) return 0;
  const logs = path.join(batch, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (const step of steps) {
    const begin = Date.now();
    try {
      if (step.copy) {
        await mkdir(path.dirname(step.copy[1]), { recursive: true });
        await copyFile(...step.copy);
      } else await run(step, logs);
    } catch (error) {
      log(`[失败] ${step.name}: ${error.message}，日志 ${path.join(logs, `${step.name}.log`)}`);
      return 1;
    }
    log(`[完成] ${step.name} ${Math.round((Date.now() - begin) / 1000)}s`);
  }
  log(`用时 ${Math.round((Date.now() - started) / 1000)}s\n本地预览根目录 ${path.join(rootDir, 'dist-preview')}`);
  log(`导览草稿 ${path.join(reports, `${date}-AgentHub导览草稿.md`)}`);
  return 0;
}

const site = 'https://agent-hub-community.github.io/newspaper/';
const previewTitle = '日报导览（链接待上线核验）', publishedTitle = '日报已上线';

// The published group message is the reviewed preview draft with its first line retitled, so the text the editor
// checked is the text that goes out; regenerating it after release would need a second review.
export function publishedMessage(draft) {
  const [first, ...rest] = draft.split('\n');
  if (first.endsWith(publishedTitle)) return draft;
  if (!first.endsWith(previewTitle)) throw new Error(`Unexpected first line of the group-message draft: ${first}`);
  return [first.slice(0, -previewTitle.length) + publishedTitle, ...rest].join('\n');
}

export function commitSubject(date) {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `Publish ${day} daily with external news and rankings`;
}

// Runs a command and returns its trimmed stdout; stderr goes to the terminal.
// A call that ignores stdout (gh run watch) gets null back, which is returned as ''.
export const output = (command, args, options = {}) => (execFileSync(command, args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024, ...options }) ?? '').trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function publish(options, { env = process.env, log = console.log, sh = output, run = execute, wait = pause } = {}) {
  const { date } = options;
  if (!options.batch || !options.external) throw new Error('publish needs --batch DIR and --external DIR');
  const batch = path.resolve(options.batch), external = path.resolve(options.external);
  const reports = path.resolve(options.reports || path.join(rootDir, '..', 'reports'));
  const draft = path.join(reports, `${date}-AgentHub导览草稿.md`);
  const final = path.join(external, 'reviewed-final.json'), selection = path.join(external, 'selection.json');
  const verify = env.VERIFY_PUBLICATION || path.join(homedir(), '.agents/skills/agenthub-daily/scripts/verify-publication.mjs');
  const git = args => sh('git', ['-C', rootDir, ...args]);
  const steps = ['release', 'commit', 'push', 'deploy', 'verify', 'message'];
  log(`发布（依次）：${steps.join(' -> ')}`);

  for (const file of [path.join(batch, 'issues.json'), draft, verify]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}; run finish first`);
  }
  if (git(['branch', '--show-current']) !== 'main') throw new Error(`${rootDir} is not on main`);
  if (git(['status', '--porcelain', '--', 'data'])) throw new Error(`${rootDir}/data has uncommitted changes`);
  if (options.dryRun) return 0;
  git(['pull', '--ff-only', '--quiet']);

  const logs = path.join(batch, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS;
  const step = async (name, action) => {
    const begin = Date.now();
    try {
      await action();
    } catch (error) {
      log(`[失败] ${name}: ${error.message}，日志 ${logs}`);
      throw error;
    }
    log(`[完成] ${name} ${Math.round((Date.now() - begin) / 1000)}s`);
  };
  let sha;
  try {
    await step('release', () => run({ name: 'release', env: childEnv, args: [path.join(rootDir, 'scripts/release.mjs'),
      '--daily-batch', batch, ...(existsSync(final) ? ['--external-draft', final, '--external-selection', selection] : []),
      '--sql-out', path.join(batch, 'feedback-catalog.sql')] }, logs));
    await step('commit', () => {
      git(['add', '--', 'data']);
      git(['commit', '--quiet', '-m', commitSubject(date)]);
      sha = git(['rev-parse', 'HEAD']);
    });
    await step('push', () => git(['push', '--quiet', 'origin', 'main']));
    await step('deploy', async () => {
      let id = '';
      for (let i = 0; i < 24 && !id; i += 1) {
        id = sh('gh', ['run', 'list', '--commit', sha, '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId'],
          { cwd: rootDir });
        if (!id) await wait(5000);
      }
      if (!id) throw new Error(`no GitHub Actions run appeared for ${sha}`);
      log(`  Actions run ${id}`);
      sh('gh', ['run', 'watch', id, '--exit-status'], { cwd: rootDir, stdio: ['ignore', 'ignore', 'inherit'] });
    });
    // Pages can serve the previous build for a short while after the deploy job ends.
    await step('verify', async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          sh(process.execPath, [verify, '--newspaper', rootDir, '--site', site, '--date', date,
            '--out', path.join(batch, 'publication-check.json')], { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
          return;
        } catch (error) {
          if (attempt >= 3) throw error;
          await wait(30000);
        }
      }
    });
    await step('message', async () => {
      const text = publishedMessage(await readFile(draft, 'utf8'));
      await writeFile(draft, text);
      await writeFile(path.join(batch, 'published-bot.md'), text);
    });
  } catch {
    return 1;
  }
  log(`已上线 ${site}daily/${date}/overview/ ，提交 ${sha.slice(0, 7)}`);
  log(`上线版导览 ${draft}（没有发群）`);
  return 0;
}

function parseArgs(argv) {
  const [command, date, ...rest] = argv;
  if (!['prepare', 'finish', 'publish'].includes(command) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('Usage: daily.mjs prepare|finish|publish YYYY-MM-DD [--batch DIR] [--external DIR] [--reports DIR]' +
      ' [--from-step STEP[,STEP]] [--dry-run]');
  }
  const options = { command, date, fromSteps: [], dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (['--batch', '--external', '--reports', '--from-step'].includes(flag) && rest[i + 1] && !rest[i + 1].startsWith('--')) {
      const value = rest[(i += 1)];
      if (flag === '--from-step') options.fromSteps.push(...value.split(',').filter(Boolean));
      else options[flag.slice(2)] = value;
    } else throw new Error(`Unexpected argument ${flag}`);
  }
  return options;
}

const quote = value => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

function execute(step, logs) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(path.join(logs, `${step.name}.log`), { flags: 'a', mode: 0o600 });
    log.write(`\n# ${new Date().toISOString()} node ${step.args.map(quote).join(' ')}\n`);
    // Scripts resolve relative paths and newspaper modules from the newspaper checkout, as in the runbook.
    const child = spawn(process.execPath, step.args, { cwd: rootDir, env: step.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', error => log.end(() => reject(error)));
    child.on('close', code => log.end(() => code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

// Runs one edition. Returns the process exit code: 1 when a chat step failed, otherwise 0 (a collect-external
// failure only warns). Tests replace `execute`, `scratch`, `env` and `log`.
export async function prepare(options, {
  scratch = path.join(rootDir, 'scratch'), env = process.env, run = execute, log = console.log,
} = {}) {
  const { date } = options;
  const entries = existsSync(scratch) ? await readdir(scratch) : [];
  const { batch, external } = resolveDirs({ ...options, scratch, entries });
  if (options.fromSteps.length && !existsSync(path.join(batch, date))) {
    throw new Error(`--from-step continues an existing batch, but ${path.join(batch, date)} does not exist; check --batch`);
  }
  const steps = selectSteps(buildPlan({ date, batch, external }), options.fromSteps);

  log(`批次目录 ${batch}\n外部资讯 ${external}`);
  if (steps.main.length) log(`  主线（依次）：${steps.main.map(step => step.name).join(' -> ')}`);
  if (steps.external) log(`  并行：${steps.external.name}`);
  const missing = missingEnv(steps, env);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} before preparing the edition (see the runbook)`);
  if (!options.fromSteps.length && existsSync(path.join(batch, date))) {
    throw new Error(`${batch} already holds ${date}; pass a new --batch, or --from-step to continue it`);
  }
  if (steps.external && existsSync(path.join(external, 'discovery.json'))) {
    throw new Error(`${external} already holds a discovery snapshot; pass a new --external directory`);
  }
  if (options.dryRun) return 0;

  const logs = path.join(batch, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const counts = async () => formatCounts(await groupCounts(date, batch)).join('\n');
  const started = Date.now();
  const result = await runPlan(steps, async step => {
    const begin = Date.now();
    log(`[开始] ${step.name}`);
    try {
      await run(step, logs);
    } catch (error) {
      log(`[失败] ${step.name}: ${error.message}，日志 ${path.join(logs, `${step.name}.log`)}`);
      throw error;
    }
    log(`[完成] ${step.name} ${Math.round((Date.now() - begin) / 1000)}s`);
    // Show the counts now, so an unsynchronized group is caught before the model drafts its page.
    if (step.name === 'collect-batch') log(await counts());
  });
  log(`用时 ${Math.round((Date.now() - started) / 1000)}s\n`);

  if (existsSync(path.join(batch, date))) log(await counts());
  if (result.externalFailed) {
    // collect-external writes its snapshot even when some sources fail, and refuses a directory that holds one.
    const retry = existsSync(path.join(external, 'discovery.json'))
      ? path.join(scratch, `external-${date}-run${nextRun(existsSync(scratch) ? await readdir(scratch) : [], date)}`) : external;
    log(`\n!! collect-external 失败，外部资讯需要补查（看 ${path.join(logs, 'collect-external.log')}），或重跑：`);
    log(`node ${quote(path.join(botDir, 'scripts/collect-external.mjs'))} ${date} ${quote(retry)}`);
  }
  if (result.failed) {
    log(`\n失败：${result.failed.name}。修好后续跑：`);
    log(`node ${quote(path.join(botDir, 'scripts/daily.mjs'))} prepare ${date} --batch ${quote(batch)}` +
      ` --from-step ${result.resume}`);
    return 1;
  }
  if (steps.main.length) {
    log(`\n准备完成。审稿补丁写到 ${path.join(batch, 'review')}/，外部资讯选题写到 ${path.join(external, 'selection.json')}，然后：`);
    log(`node ${quote(path.join(botDir, 'scripts/daily.mjs'))} finish ${date} --batch ${quote(batch)} --external ${quote(external)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const commands = { prepare, finish, publish };
  process.exitCode = await commands[options.command](options);
}
