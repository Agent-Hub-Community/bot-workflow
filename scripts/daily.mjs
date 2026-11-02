// Prepares one daily edition with a single command: collects chats and images, collects external candidates,
// drafts and packages the group pages, adds comments/headlines/emphasis, and prepares the activity board.
//   node "$BOT/scripts/daily.mjs" prepare YYYY-MM-DD [--batch DIR] [--external DIR] [--from-step STEP[,STEP]] [--dry-run]
// The chat steps run one after another; each reads the previous step's output, and running them in sequence also
// keeps the three WeChat-database steps from overlapping. collect-external reads no database and runs beside them.
// A collect-external failure only warns, so the chat pages still get prepared. Each step writes its output to
// BATCH/logs/<step>.log. When a chat step fails the script stops the chat steps and prints the --from-step command
// that resumes at that step.
import { createWriteStream, existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
  return {
    batch: path.resolve(batch || path.join(scratch, `day-${date}-run${run}`)),
    external: path.resolve(external || path.join(scratch, `external-${date}-run${run}`)),
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
async function avatarReview(batch) {
  const file = path.join(batch, 'activity', 'avatar-review.json');
  if (!existsSync(file)) return `头像审核：${file} 还没生成，release-activity 跑完后检查其中的 pending。`;
  const { pending = [] } = JSON.parse(await readFile(file, 'utf8'));
  return pending.length
    ? `!! ${pending.length} 个新头像待人工查看：逐张看过后清空 ${file} 的 pending 才能发布。`
    : `头像审核：${file} 的 pending 为空。`;
}

function parseArgs(argv) {
  const [command, date, ...rest] = argv;
  if (command !== 'prepare' || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    throw new Error('Usage: daily.mjs prepare YYYY-MM-DD [--batch DIR] [--external DIR] [--from-step STEP[,STEP]] [--dry-run]');
  }
  const options = { date, fromSteps: [], dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (['--batch', '--external', '--from-step'].includes(flag) && rest[i + 1] && !rest[i + 1].startsWith('--')) {
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
    const child = spawn(process.execPath, step.args, { cwd: rootDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  log(await avatarReview(batch));
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
  if (steps.main.length) log(`\n准备完成。下一步按编辑标准审稿，然后跑 finalize-batch.mjs ${batch}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await prepare(parseArgs(process.argv.slice(2)));
}
