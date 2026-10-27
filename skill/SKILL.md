---
name: agenthub-daily
description: "生成 Agent Hub 社区日报或自然周周报：从本机微信群聊和外部资讯采集材料，用 OpenAI 兼容模型写正文和 AI 锐评，编辑审核，计算活跃榜，本地预览；获得授权后发布到 GitHub Pages 并准备导览文案。支持续跑和修订，历史刊期保持当时的群覆盖。"
---

# Agent Hub 日报与周报

跑一期日报或周报时，把群聊、外部资讯、AI 锐评、活跃榜、网页预览和发群导览草稿一次做齐，别等用户一项项催。脚本负责搬运数据和做格式检查，但选题、回原文核实、改错和审隐私得由 agent 自己把关。

## 路径与环境变量

| 变量 | 含义 |
|---|---|
| `$NEWSPAPER` | `newspaper` 仓库根目录（`Agent-Hub-Community/newspaper`），日常命令默认站在这里跑 |
| `$BOT` | `bot-workflow` 仓库根目录（`scripts/` 写稿、`prompts/` 指令、`lib/llm.mjs` 模型配置） |
| `$PIPELINE` | `$BOT/pipeline`，读本机微信数据的采集脚本 |
| `$SKILL_DIR` | 本 skill 所在目录 |
| `$WX_HOME` | wx CLI 用的微信账号 HOME，传给脚本时用 `WX_ACTIVITY_HOME` |
| `$BATCH` | 单日批次目录，默认 `$NEWSPAPER/scratch/day-D-runN` |
| `$EXTERNAL` | 外部资讯目录，默认 `$NEWSPAPER/scratch/external-D-runN` |
| `$REPORTS` | 交付报告与导览草稿目录，放在两个仓库外面 |
| `$SITE` | 线上地址 `https://agent-hub-community.github.io/newspaper/` |

`D` 是刊期日期（`YYYY-MM-DD`）。模型接口配在 `DAILY_LLM_BASE_URL` 和 `DAILY_LLM_API_KEY`，模型名配在 `DAILY_LLM_MODEL`（默认 `gemini-4-argon`）。其余变量见 `bot-workflow/config/env.example`。

## 用户常见说法与执行范围

| 用户怎么说 | 做到哪一步 |
|---|---|
| “生成昨日完整日报” / “跑一下今天的日报” | 默认取上一个完整的北京时间自然日。做完群稿、外部资讯、榜单、本地预览和导览草稿，不推上线。 |
| “生成并发布昨日完整日报” | 同一轮里一路做完审稿、入库、登记反馈目录、推送部署和已上线版导览文案，中间不再停下来问。 |
| “生成上周周报” / “来一下周报” | 取上一个完整的北京时间自然周，按[周报流程](references/weekly.md)做完各群、外部资讯、周榜、资料库与黑话增量、本地预览和导览草稿，不推上线。 |
| “本周截至现在的周报” | 做周一到当前时刻的阶段稿，明确标为未完周。 |
| “生成并发布上周周报” | 走完整周报流程，入库、登记、推送并确认部署。 |
| “上线吧” / “推上去呗” | 把本轮刚审好的那期推上线（跨过午夜也别改日期），不重采、不重写。 |
| “继续” | 从当前批次第一个没跑完的步骤接着往下做，保持原来的预览或发布模式。 |
| “只改锐评 / 隐私 / 某条链接” | 只改指出的地方，重跑受影响的预览或构建，不重算榜单、不重跑整期。 |
| “更新资料库” / “更新黑话词典” | 按[周报流程](references/weekly.md)第 7 节从上次 `through` 的次日起做一次增量并本地预览，不推上线。 |

拿不准日期但当前批次能看出来时，直接按批次定；只有刊期、目标或发布权限真有歧义才问用户。“发布／上线”只代表允许更新网站和反馈数据库，不代表允许往微信群发消息、合并别的 PR 或改付费配置。导览文案默认只写草稿不发群。

一期完整的新日报包含：`$NEWSPAPER/lib/groups.mjs` 里当天必出读者版面的主群（`pageGroups(D)`，一群到五群）、当天有实质讨论内容的垂类专项群（`optionalPageGroups(D)`：AI Safety、Robot、AI4S，有信息量时纳入日报与本日总览，无实质内容时不展示空版）、同日外部资讯、各版报头、正文重点、AI 锐评、资料卡片、讨论节选、各主群日榜与社区周／月／总榜、本地预览和一条合并导览草稿。修旧刊期时保留当年的群范围，不替当时还没建的群补空版，也不把当前的社区榜倒退回旧日期。

## 一期日报怎么跑

先分清是日报还是周报。周报直接看[周报流程](references/weekly.md)；下面是日报的 6 个步骤，具体命令看[操作手册](references/runbook.md)，审稿要求看[编辑标准](references/editorial-standards.md)。

1. 定下日期 `D`、北京时间窗口和本轮做预览还是发布。串行导出各群整日消息和图片描述，算好 `$BATCH/activity/` 活跃榜；外部资讯可以同时开跑。注意同一个微信账号的数据库读取不要并发。
2. 调模型生成各群初稿、报头、重点和 AI 锐评（`prepare-week-d.mjs generate/package` + `enrich-month-d.mjs`）。对照 `raw.json` 核对原话、谁说的、谁回谁的，删掉注水条目，把同一人连发的工具合并，改掉事实和隐私问题。
3. 外部资讯按[资讯补查](references/external-sources.md)把脚本没扫到的来源补齐，点开原文核实后写 `selection.json`，再调模型写稿和锐评。
4. 逐张检查新上榜成员的头像并清空 `avatar-review.json` 的 `pending`；逐条审核正文里的 `emphasis` 下划线片段；把资料链接和匿名讨论节选合进 `$BATCH/issues.json`，跑 `node "$BOT/scripts/finalize-batch.mjs" "$BATCH"` 做 schema 与隐私校验。
5. 跑 `prepare-preview.mjs` 生成本地预览，抽检手机（375px）和桌面（1440px）版面、讨论弹窗与榜单，再生成一条合并导览草稿。如果本轮只做预览，到这里交付。
6. 如果已获准发布，跑 `publish-reviewed-batch.mjs`、`import-external-report.mjs`、公开构建、`embed-catalog.mjs`、D1 反馈目录登记和 `npm test`，提交推送并确认 GitHub Actions 部署成功，生成正式版导览文案，把链接、提交 SHA 交给用户，并注明导览尚未发群。

## 资料库、机会、黑话与语义向量

资料库（`/library/`）、机会（招聘、活动、征稿）和群聊黑话（`/glossary/`）的数据在 `newspaper/data/` 下，每周随周报集中更新一次（见[周报流程](references/weekly.md)第 7 节）。平时发单日日报不用动它们，交付时顺带提一句距离上次更新隔了几天即可。

每次正式发布日报、周报或资料库，都在公开构建后、提交前跑一次 `node scripts/embed-catalog.mjs` 更新 `data/semantic-vectors.json`，供站内语义搜索使用。
