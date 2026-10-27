# 周报流程

## 周报做什么

周报按北京时间自然周（周一 `00:00` 到下周一 `00:00`）整理一周的内容：每个有读者版面的群各占一版，外加一版一周外部资讯和各群独立的周活跃榜，顺带把这一周新出现的资料库条目、招聘／活动机会和群聊黑话一起补齐。

周报不是把七篇日报拼在一起：

- 同一个问题如果在好几天里陆续有人接着聊，就按时间串起来，写清楚最开始在问什么、后面几天谁补了新数据或新试法、到周末还有什么没定下来。
- 只在某一天聊过、但内容很扎实的话题，照样单独成条，不用为了凑“本周主线”硬跟别的话题绑在一起，也别删掉。
- 条数不限，一个热闹的群一周写 10 到 15 条很常见。

## 1. 定时间窗口与批次目录

默认取上一个已经过完的自然周（周一到周日）。用下面这个小脚本可以算出准确的起止时间和 ISO 窗口：

```sh
node "$SKILL_DIR/scripts/weekly-window.mjs"
node "$SKILL_DIR/scripts/weekly-window.mjs" --from 2026-10-19 --through 2026-10-25
```

批次目录放在 `$NEWSPAPER/scratch/weekly-FROM_THROUGH-runN/`（下文记作 `$BATCH`）。如果只覆盖了不到七天、或者本周还没过完，标题和说明里要标成“区间回顾”或阶段稿，别直接叫完整自然周。

## 2. 准备七天的群聊输入

平时每天跑日报留下的 `scratch/day-*/<日期>/group-N.input.json`（和对应的 `raw.json`）可以直接复用。开跑前先把“7 天 × 各群”列张表对一遍：哪天已经有完整记录、哪天还没采、哪个群是在本周中途才建群的。缺了哪天就用 `$PIPELINE/collect-batch.mjs` 补采并跑完读图。

和日报一样，本地查到 0 条只记为 `no_local_records`，核实清楚前别轻易下结论说那天没人说话。

## 3. 调模型写各群周报

写周报时，喂给模型的是这一周各天的原始脱敏消息（由脚本把每天的 `p1`、`p2` 加上日期和群前缀区分开），不要拿写好的日报正文去二次缩写。

- 生成脚本是 `$BOT/scripts/generate-weekly-gemini.mjs`，prompt 是 `$BOT/prompts/weekly-editor-gemini.md`（周报默认不开 `reasoning_effort: high`，免得长输入把输出 token 预算耗光）。
- 每版周报有一个总标题（提炼这群本周最有意思的看点）和简短导语。每条故事写清日期、具体做法或争论点，配一句 AI 锐评、重点下划线和最多一个公开链接。
- 文风和日报一样：直接写事，少来“讨论重心逐步聚焦”“形成闭环”那套总结腔。

## 4. 一周外部资讯

周报的外部资讯版回顾这一周行业里真正在发生的事：模型与产品发布、开源项目、芯片算力、重要论文和后续进展。

- 可以把本周已发布的日报外部资讯当线索库，但要通盘再筛一遍：同一个产品一周内连续发的小更新合并成一条写；日报漏掉的重要发布按[资讯补查](external-sources.md)补齐。
- 论文按这一周的实际影响和研究价值挑，不套用日报“HF 与 alphaXiv 双榜前五”的硬门槛。

## 5. 各群独立周榜

周报里的周榜按群单算（每个群列出本周发言最多的前 3 名），和日报里的“全社区合并榜”不是一回事，也不直接把七天日榜的前三名加起来算。

用同一周各群去重后的原始记录和 `$NEWSPAPER/lib/activity.mjs` 的计分规则算出各群 Top 3，新头像逐张肉眼审过。周报的榜单快照只跟这一期周报走，不改动日报正在用的 `data/public-activity/snapshot.json`。

## 6. 跑通周报与原始讨论节选

`$GROUPS` 填本周有周报版面的群（默认由 `newspaper/lib/groups.mjs` 的 `weeklyGroups` 决定，包含日常群 `group-1` 到 `group-5` 以及专项群 `group-6` AI Safety、`group-7` Robot、`group-8` AI4S），`FROM` 和 `THROUGH` 填起止日期：

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" FROM THROUGH "$BATCH"
node "$BOT/scripts/generate-weekly-gemini.mjs" FROM THROUGH "$BATCH" "$BATCH/weekly-pages" --groups "$GROUPS"
node "$BOT/scripts/generate-weekly-emphasis.mjs" "$BATCH/weekly-pages"

# 审完各群与外部资讯、组装出 $BATCH/reader/reader.json 之后，配原始讨论节选：
node "$BOT/scripts/weekly-discussion-evidence.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence"
node "$BOT/scripts/weekly-attach-discussions.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence" "$BATCH/discussion-audit.json"
node "$BOT/scripts/weekly-select-discussion.mjs" "$BATCH/reader/reader.json" "$BATCH/select" \
  --audit "$BATCH/discussion-audit.json"
```

原始讨论节选分三步走：

1. `weekly-discussion-evidence.mjs`：让模型按每条故事提到的日期回去翻当天的 `input.json`，把和这个话题相关的消息 ref（形如 `2026-10-20:m0012`）全捞出来。
2. `weekly-attach-discussions.mjs`：对照同日同群的 `raw.json` 补齐引用回复，按 `日期/群/pN` 区分发言人（不会把周二的 `p1` 和周三的 `p1` 当成同一个人），并在单条故事内部编成“群友 1”“群友 2”，同时把正文里出现的跨群昵称也替换掉。如果有审稿确认要剔除的消息或引用，加 `--exclusions "$BATCH/discussion-exclusions.json"` 传进去。
3. `weekly-select-discussion.mjs`：把过长的对话筛到 20 到 40 条主干回合，去掉复读、纯表情和“+1”。务必带上 `--audit "$BATCH/discussion-audit.json"`，这样筛掉中间某几条后，留下的消息仍然保持原来的“群友 N”编号，引用头也不会串人。

讨论配好并复核无误后，入库并生成导览草稿：

```sh
node scripts/import-reviewed-weekly.mjs "$BATCH/reader"
node "$BOT/scripts/generate-weekly-bot.mjs" "data/weekly-editions/FROM_THROUGH.json" \
  "$REPORTS/FROM_THROUGH-AgentHub周报导览草稿.md" \
  --split-dir "$REPORTS/FROM_THROUGH-bot"
```

## 7. 同步更新资料库、机会与黑话

每次做周报时，顺手把资料库（`data/library.json`）、机会（`data/opportunities.json`）和群聊黑话（`data/glossary.json`）从上次各自的 `through` 次日补到本周日：

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-library-candidates.mjs" --since <library 的 through 次日>
# 按 newspaper/docs/review/library.md 审核，写到 scratch/library/curated/*.json
node scripts/check-library-review.mjs
node scripts/assemble-library.mjs          # 逐张看过新头像、写好 avatar-review.json 后再跑一次

node "$PIPELINE/collect-opportunity-candidates.mjs" --since <opportunities 的 through 次日>
# 按 newspaper/docs/review/opportunities.md 审核，写到 scratch/opportunities/reviewed.json
node scripts/assemble-opportunities.mjs

node "$PIPELINE/collect-glossary-chunks.mjs" --since <glossary 的 through 次日>
# 按 newspaper/docs/review/glossary.md 审核，合进 data/glossary.json 并更新 through
```

还可以跑一下 `node scripts/search-stats.mjs` 看看读者最近在站内搜过哪些零结果词，把确实常用的缩写或同义写法补进黑话词典或 `data/search-synonyms.json`。

## 8. 预览、验收与发布

把周报和资料库增量合在一起跑本地构建与浏览器测试：

```sh
npm test
npm run build
node test/build.mjs
node test/library-browser.mjs
VERIFY_SITE="http://127.0.0.1:$PORT/newspaper" node test/weekly-browser.mjs
```

在 375px 和 1440px 下抽检各群周报页、外部资讯页和周榜页。

拿到发布同意后，跑公开构建、登记 D1 点心与反馈目录、更新语义向量并推送部署：

```sh
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
node scripts/feedback-catalog.mjs dist/data.js "$BATCH/feedback-catalog.sql"
"$WRANGLER_BIN" d1 execute agenthub-feedback --remote --config feedback/wrangler.jsonc --file "$BATCH/feedback-catalog.sql"
node scripts/embed-catalog.mjs
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
npm test
node test/build.mjs --public
```

把 `data/weekly-editions/`、`data/weekly-assets/`、`data/library.json`、`data/library-avatars/`、`data/opportunities.json`、`data/glossary.json` 和 `data/semantic-vectors.json` 一起提交推送，等 Pages 部署完成后核对线上页面与搜索接口。
