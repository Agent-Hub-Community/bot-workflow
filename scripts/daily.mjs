// Deterministic daily runner for the Antigravity-native AgentHub workflow (zero external LLM API calls).
//   node "$BOT/scripts/daily.mjs" collect YYYY-MM-DD [--batch DIR] [--external DIR] [--from-step STEP[,STEP]] [--dry-run]
//   node "$BOT/scripts/daily.mjs" finish  YYYY-MM-DD --batch DIR --external DIR [--dry-run]
//   node "$BOT/scripts/daily.mjs" publish YYYY-MM-DD --batch DIR --external DIR [--reports DIR] [--verify] [--dry-run]
//
// 1. `collect`: runs all 3 WeChat DB steps sequentially (collect-batch -> collect-images decode-only ->
//    prepare-release-activity) while scraping external candidates (collect-external) in parallel.
// 2. Antigravity spawns parallel subagents to read each group's input.json + decoded media images and write
//    BATCH/<date>/<group>.draft.json directly, plus one subagent to write EXTERNAL/reviewed-final.json.
// 3. `finish`: runs package-daily.mjs (packages drafts, auto-mounts media attachments, writes bot-input.json)
//    and newspaper/scripts/prepare-preview.mjs (builds local preview with attachments).
// 4. `publish`: runs newspaper/scripts/release.mjs, commits & pushes data/, waits for Pages deploy, and
//    retitles the WeChat guide draft to "日报已上线".
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, rootDir } from '../lib/newspaper-root.mjs';

const botDir = fileURLToPath(new URL('../', import.meta.url));

export function beijingYesterday(now = Date.now()) {
  return new Date(now + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
}

export function buildCollectPlan({ date, batch, external, bot = botDir, throughNow = false }) {
  const pipeline = path.join(bot, 'pipeline'), scripts = path.join(bot, 'scripts');
  const tail = throughNow ? ['--through-now'] : [];
  return {
    main: [
      { name: 'collect-batch', wechat: true,
        args: [path.join(pipeline, 'collect-batch.mjs'), date, date, batch, ...tail] },
      { name: 'collect-images', wechat: true,
        args: [path.join(pipeline, 'collect-images.mjs'), date, batch] },
      { name: 'release-activity', wechat: true,
        args: [path.join(pipeline, 'prepare-release-activity.mjs'), batch, '--date', date] },
    ],
    external: { name: 'collect-external', wechat: false,
      args: [path.join(scripts, 'collect-external.mjs'), date, external, ...tail] },
  };
}

const stepsOf = ({ main, external }) => [...main, ...(external ? [external] : [])];

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

export function nextRun(entries, date) {
  const taken = new Set(entries);
  let run = 1;
  while (taken.has(`day-${date}-run${run}`) || taken.has(`external-${date}-run${run}`)) run += 1;
  return run;
}

export function resolveDirs({ date, batch, external, fromSteps = [], scratch, entries }) {
  if (fromSteps.length && !batch) throw new Error('--from-step continues an existing batch; pass --batch DIR');
  const run = nextRun(entries, date);
  const paired = batch && path.basename(path.resolve(batch)).match(/^day-(\d{4}-\d{2}-\d{2}-run\d+)$/);
  return {
    batch: path.resolve(batch || path.join(scratch, `day-${date}-run${run}`)),
    external: path.resolve(external || (paired ? path.join(path.dirname(path.resolve(batch)), `external-${paired[1]}`)
      : path.join(scratch, `external-${date}-run${run}`))),
  };
}

export function missingEnv(selected, env) {
  const steps = stepsOf(selected);
  const names = steps.some(step => step.wechat) ? ['WX_ACTIVITY_HOME'] : [];
  return names.filter(name => !env[name]);
}

export function formatCounts(rows) {
  const lines = rows.map(({ label, id, count, images }) => count === null
    ? `  !! ${label} (${id}): 没有 raw.json，采集没跑完`
    : count === 0 ? `  !! ${label} (${id}): 0 条，核实是当天没人说话还是客户端未同步`
      : `     ${label} (${id}): ${count} 条${images ? `（已解图 ${images} 张）` : ''}`);
  const empty = rows.filter(row => !row.count).length;
  return [`各群条数：`, ...lines, ...(empty ? [`!! ${empty} 个群为 0 条或缺失，先核实同步情况。`] : [])];
}

async function groupCounts(date, batch) {
  const { collectedGroups } = await load('lib/groups.mjs');
  return Promise.all(collectedGroups(date).map(async ({ id, label }) => {
    try {
      const raw = JSON.parse(await readFile(path.join(batch, date, `${id}.raw.json`), 'utf8'));
      const imgs = await readFile(path.join(batch, date, `${id}.images.json`), 'utf8')
        .then(t => JSON.parse(t).filter(r => r.file).length, () => 0);
      return { id, label, count: raw.length, images: imgs };
    } catch (error) {
      if (error.code === 'ENOENT') return { id, label, count: null, images: 0 };
      throw error;
    }
  }));
}

export function buildFinishPlan({ date, batch, external, has, bot = botDir, newspaper = rootDir }) {
  const scripts = path.join(bot, 'scripts');
  const final = external ? path.join(external, 'reviewed-final.json') : null;
  const selection = external ? path.join(external, 'selection.json') : null;
  const withExternal = Boolean(final && has(final));
  const withSelection = Boolean(withExternal && selection && has(selection));
  return [
    { name: 'package-daily',
      args: [path.join(scripts, 'package-daily.mjs'), date, batch, ...(external ? ['--external', external] : [])] },
    { name: 'link-previews', optional: true,
      args: [path.join(scripts, 'fetch-link-previews.mjs'), '--batch', batch] },
    { name: 'preview',
      args: [path.join(newspaper, 'scripts/prepare-preview.mjs'), '--date', date, '--batch', batch,
        ...(withExternal ? ['--external-draft', final, ...(withSelection ? ['--external-selection', selection] : [])] : [])] },
  ];
}

export async function finish(options, { run = execute, log = console.log } = {}) {
  const { date } = options;
  if (!options.batch) throw new Error('finish needs --batch DIR');
  const batch = path.resolve(options.batch);
  const external = options.external ? path.resolve(options.external) : null;
  const steps = buildFinishPlan({ date, batch, external, has: existsSync });
  log(`收尾（依次）：${steps.map(step => step.name).join(' -> ')}`);
  if (options.dryRun) return 0;
  const logs = path.join(batch, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (const step of steps) {
    const begin = Date.now();
    try {
      await run(step, logs);
    } catch (error) {
      if (step.optional) {
        log(`[警告] ${step.name} 未完成（不阻断预览）：${error.message}，日志 ${path.join(logs, `${step.name}.log`)}`);
        continue;
      }
      log(`[失败] ${step.name}: ${error.message}，日志 ${path.join(logs, `${step.name}.log`)}`);
      return 1;
    }
    log(`[完成] ${step.name} ${Math.round((Date.now() - begin) / 1000)}s`);
  }
  log(`用时 ${Math.round((Date.now() - started) / 1000)}s\n本地预览根目录 ${path.join(batch, 'preview')}`);
  log(`导览输入 ${path.join(batch, 'bot-input.json')}`);
  return 0;
}

const site = 'https://agent-hub-community.github.io/newspaper/';
const previewTitle = '日报导览（链接待上线核验）', publishedTitle = '日报已上线';

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

export const output = (command, args, options = {}) => (execFileSync(command, args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 20 * 1024 * 1024, ...options }) ?? '').trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function publish(options, { env = process.env, log = console.log, sh = output, run = execute, wait = pause } = {}) {
  const { date } = options;
  if (!options.batch) throw new Error('publish needs --batch DIR');
  const batch = path.resolve(options.batch);
  const external = options.external ? path.resolve(options.external) : null;
  const reports = path.resolve(options.reports || path.join(rootDir, '..', 'reports'));
  const draft = path.join(reports, `${date}-AgentHub导览草稿.md`);
  const final = external ? path.join(external, 'reviewed-final.json') : null;
  const selection = external ? path.join(external, 'selection.json') : null;
  const verify = env.VERIFY_PUBLICATION || path.join(botDir, 'skill/scripts/verify-publication.mjs');
  const git = args => sh('git', ['-C', rootDir, ...args]);
  const steps = ['release', 'commit', 'push', 'deploy', ...(options.verify ? ['verify'] : []), ...(existsSync(draft) ? ['message'] : [])];
  log(`发布（依次）：${steps.join(' -> ')}`);

  if (!existsSync(path.join(batch, 'issues.json'))) throw new Error(`Missing ${path.join(batch, 'issues.json')}; run finish first`);
  if (options.verify && !existsSync(verify)) throw new Error(`Missing ${verify}`);
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
    const withExternal = Boolean(final && existsSync(final));
    const withSelection = Boolean(withExternal && selection && existsSync(selection));
    await step('release', () => run({ name: 'release', env: childEnv, args: [path.join(rootDir, 'scripts/release.mjs'),
      '--daily-batch', batch,
      ...(withExternal ? ['--external-draft', final, ...(withSelection ? ['--external-selection', selection] : [])] : [])] }, logs));
    await run({ name: 'link-previews', env: childEnv, args: [path.join(botDir, 'scripts/fetch-link-previews.mjs'), '--batch', batch] }, logs)
      .catch(error => log(`[警告] link-previews 未完成（不阻断发布）：${error.message}`));
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
    if (options.verify) {
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
    }
    if (existsSync(draft)) {
      await step('message', async () => {
        const text = publishedMessage(await readFile(draft, 'utf8'));
        await writeFile(draft, text);
        await writeFile(path.join(batch, 'published-bot.md'), text);
      });
    }
  } catch {
    return 1;
  }
  log(`已上线 ${site}daily/${date}/overview/ ，提交 ${sha.slice(0, 7)}`);
  if (existsSync(draft)) log(`上线版导览 ${draft}（没有发群）`);
  return 0;
}

function parseArgs(argv) {
  const [command, date, ...rest] = argv;
  if (!['collect', 'finish', 'publish'].includes(command) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('Usage: daily.mjs collect|finish|publish YYYY-MM-DD [--batch DIR] [--external DIR] [--reports DIR]' +
      ' [--from-step STEP[,STEP]] [--through-now|--strict-day] [--verify] [--dry-run]');
  }
  const options = { command, date, fromSteps: [], dryRun: false, verify: false, throughNow: undefined };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--verify') options.verify = true;
    else if (flag === '--through-now') options.throughNow = true;
    else if (flag === '--strict-day') options.throughNow = false;
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
    const child = spawn(process.execPath, step.args, { cwd: rootDir, env: step.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', error => log.end(() => reject(error)));
    child.on('close', code => log.end(() => code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

export async function collect(options, {
  scratch = path.join(rootDir, 'scratch'), env = process.env, run = execute, log = console.log,
} = {}) {
  const { date } = options;
  const entries = existsSync(scratch) ? await readdir(scratch) : [];
  const { batch, external } = resolveDirs({ ...options, scratch, entries });
  if (options.fromSteps.length && !existsSync(path.join(batch, date))) {
    throw new Error(`--from-step continues an existing batch, but ${path.join(batch, date)} does not exist; check --batch`);
  }
  const throughNow = options.throughNow ?? (date === beijingYesterday());
  const steps = selectSteps(buildCollectPlan({ date, batch, external, throughNow }), options.fromSteps);

  log(`批次目录 ${batch}\n外部资讯 ${external}`);
  if (throughNow) log(`  窗口：${date} 00:00 至生成时刻（上一完整自然日 + 今日截至当下）`);
  if (steps.main.length) log(`  主线（依次）：${steps.main.map(step => step.name).join(' -> ')}`);
  if (steps.external) log(`  并行：${steps.external.name}`);
  const missing = missingEnv(steps, env);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} before collecting the edition (see the runbook)`);
  if (!options.fromSteps.length && existsSync(path.join(batch, date))) {
    throw new Error(`${batch} already holds ${date}; pass a new --batch, or --from-step to continue it`);
  }
  if (steps.external && existsSync(path.join(external, 'discovery.json'))) {
    throw new Error(`${external} already holds a discovery snapshot; pass a new --external directory`);
  }
  if (options.dryRun) return 0;

  const logs = path.join(batch, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
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
  });
  log(`用时 ${Math.round((Date.now() - started) / 1000)}s\n`);

  if (existsSync(path.join(batch, date))) log(formatCounts(await groupCounts(date, batch)).join('\n'));
  if (result.externalFailed) {
    const retry = existsSync(path.join(external, 'discovery.json'))
      ? path.join(scratch, `external-${date}-run${nextRun(existsSync(scratch) ? await readdir(scratch) : [], date)}`) : external;
    log(`\n!! collect-external 失败，外部资讯需要补查（看 ${path.join(logs, 'collect-external.log')}），或重跑：`);
    log(`node ${quote(path.join(botDir, 'scripts/collect-external.mjs'))} ${date} ${quote(retry)}`);
  }
  if (result.failed) {
    log(`\n失败：${result.failed.name}。修好后续跑：`);
    log(`node ${quote(path.join(botDir, 'scripts/daily.mjs'))} collect ${date} --batch ${quote(batch)}` +
      ` --from-step ${result.resume}`);
    return 1;
  }
  if (steps.main.length) {
    log(`\n采集完成。由 Antigravity 并行 subagent 写完 ${path.join(batch, date)}/<group>.draft.json 和 ${path.join(external, 'reviewed-final.json')} 后运行：`);
    log(`node ${quote(path.join(botDir, 'scripts/daily.mjs'))} finish ${date} --batch ${quote(batch)} --external ${quote(external)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const commands = { collect, finish, publish };
  process.exitCode = await commands[options.command](options);
}
