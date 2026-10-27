# 写稿与审核脚本（scripts）

这里的脚本负责调模型写群稿、外部资讯、周报、AI 锐评、报头、重点和发群导览，并把审改后的稿件组装成 `newspaper` 能直接预览和入库的 `issues.json`。模型 prompt 放在 `prompts/`，接口配置统一走 `lib/llm.mjs`。

## 运行约定

- 日常命令默认站在 `newspaper` 仓库根目录下跑，写成 `node "$BOT/scripts/xxx.mjs" ...`。
- 相对路径按当前目录解析，批次目录一般放在 `newspaper/scratch/` 下（已被 Git 忽略）。
- 脚本通过 `lib/newspaper-root.mjs` 找 `newspaper` 仓库：优先读 `NEWSPAPER_DIR`，没设就找本仓库旁边的 `../newspaper`。`linkedom` 等第三方包也从 `newspaper/node_modules` 加载。

## 1. 日报流程

```sh
cd "$NEWSPAPER"
D=2026-10-25
B=scratch/day-$D-run1

# 先跑 pipeline/collect-batch.mjs 和 collect-images.mjs 拿到 $B/$D/group-N.input.json
node "$BOT/scripts/prepare-week-d.mjs" generate "$D" "$D" "$B" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package "$D" "$D" "$B" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$B"

# 对照原文改完错、挂好资料链接与讨论节选后，一步校验定稿：
node "$BOT/scripts/finalize-batch.mjs" "$B"
```

### 各步说明

- `prepare-week-d.mjs generate`：按群并行调 `generate-daily-gemini.mjs` 写初稿。prompt 是 `prompts/daily-group.md`（带 `--emphasis` 时拼上 `daily-emphasis.md`），请求带 `reasoning_effort: high`，最大输出 32768 token。模型偶发把重点片段抄差一两个字时，脚本会自动带 `--repair-emphasis` 单独修一次；还不行再整群重跑。原稿存为 `<群>.draft.json`，耗时与 token 用量记在 `<群>.run.json`。加 `--resume` 可以跳过已有合格初稿的群。
- `prepare-week-d.mjs package`：按 `newspaper/lib/groups.mjs` 的 `pageGroups(D)` 把当天有版面的群合进 `issues.json`。
- `enrich-month-d.mjs`：调 `generate-comments.mjs`、`generate-headlines.mjs` 和 `generate-emphasis.mjs` 补齐每条的 AI 锐评、每版的报头和重点短句。某一项单独失败时可以单跑对应脚本，再加 `--assemble` 合并。
- `apply-month-review.mjs`：把人工审稿的删改意见（`review.json`）应用到 `issues.json`，写出一份 `review-applied.json` 留底，不覆盖模型原稿。
- `month-report.mjs`：检查各群输入是不是完整自然日、分页读到底没有，给空版填上默认报头，并输出一份 `整理说明.md`。
- `package-month-resources.mjs B [--fetch]`：核对初稿里提取的链接有没有证据支持，输出 `resources.json` 和 `resources-audit.json`；加 `--fetch` 会实际请求网页核对标题。
- `finalize-batch.mjs`：校验改好的正文、重点、锐评、资料和原始讨论节选（支持直接校验 `$B/issues.json` 或合并 `--attachments`），详见[定稿说明](../docs/finalize.md)。

## 2. 外部资讯

```sh
E=scratch/external-$D-run1
node "$BOT/scripts/collect-external.mjs" "$D" "$E"
# 补查其他来源、点开原文核实后写成 $E/selection.json
node "$BOT/scripts/generate-external.mjs" "$E/selection.json" "$E/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$E/draft.json" "$E/commented-draft.json"
```

`collect-external.mjs` 只抓 AIHOT、HF 当日论文、alphaXiv、HN 和 X 的基础候选；怎么补查博客、回原文和写 `selection.json` 见 [`skill/references/external-sources.md`](../skill/references/external-sources.md)。审完后直接用 `newspaper` 的 `scripts/import-external-report.mjs` 入库。

## 3. 周报

```sh
node "$BOT/scripts/generate-weekly-gemini.mjs" FROM THROUGH "$BATCH" "$BATCH/weekly-pages" [--groups group-1,...]
node "$BOT/scripts/generate-weekly-emphasis.mjs" "$BATCH/weekly-pages"
node "$BOT/scripts/weekly-discussion-evidence.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence"
node "$BOT/scripts/weekly-attach-discussions.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence" "$BATCH/discussion-audit.json"
node "$BOT/scripts/weekly-select-discussion.mjs" "$BATCH/reader/reader.json" "$BATCH/select" \
  --audit "$BATCH/discussion-audit.json"
```

- `generate-weekly-gemini.mjs` 用 `prompts/weekly-editor-gemini.md` 为每个群写整周回顾；`generate-weekly-emphasis.mjs` 补选重点短句。
- 后面三个 `weekly-*-discussion*.mjs` 脚本负责给周报话题配原始讨论节选：先让模型按日期找出话题涉及的消息 ref，再结合 `raw.json` 补齐同日引用回复、把跨群昵称统一换成“群友 N”，最后筛出 20 到 40 条主干对话。传 `--audit` 能保证筛掉废话后原有的“群友 N”编号不重排，也不会把不同天碰巧同叫 `p1` 的两个人混成同一个人。

## 4. 导览文案与通用模型调用

- `generate-bot.mjs DATA_JSON YYYY-MM-DD OUTPUT_MD [--notes FILE] [--site URL] [--preview]`：用 `prompts/daily-bot.md` 生成发到群里的日报合并导览。
- `generate-weekly-bot.mjs ISSUE_JSON OUTPUT_MD [--base-url URL] [--split-dir DIR]`：按周报数据直接拼出周报导览文案（不调模型）。
- `call-llm.mjs PROMPT_FILE OUTPUT [--system FILE] [--reasoning low|medium|high] [--max-tokens N]`：把任意 prompt 文件发给 `lib/llm.mjs` 配置的模型，周报分片或单条返工时常用。

## 测试

在仓库根目录跑 `NEWSPAPER_DIR=/path/to/newspaper npm test`。测试使用本地假模型服务，不发真实网络请求。
