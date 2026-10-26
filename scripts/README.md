# 写稿脚本（scripts）

这里的脚本调用模型写群稿、外部资讯、周报、AI 锐评、报头、重点和导览文案。打包与定稿工具生成 newspaper 仓库能预览和入库的 `issues.json`。prompt 在本仓库的 `prompts/`，模型配置在 `lib/llm.mjs`。

## 运行约定

- 命令在 newspaper 仓库根目录下执行，写成 `node "$BOT/scripts/xxx.mjs" ...`，`$BOT` 是本仓库根目录。
- 相对路径参数按当前目录解析。批次目录默认放在 newspaper 仓库的 `scratch/` 下，该目录被 Git 忽略。
- 脚本经 `lib/newspaper-root.mjs` 找到 newspaper 仓库：设置了 `NEWSPAPER_DIR` 时用它，否则用本仓库旁边的 `../newspaper`。网站模块用 `load('lib/xxx.mjs')` 加载，例如群列表 `lib/groups.mjs`、校验 `lib/daily-generation.mjs`。
- 本仓库没有自己的 npm 依赖。`collect-external.mjs` 和 `package-month-resources.mjs` 用到的 `linkedom` 从 newspaper 仓库的 `node_modules` 加载。

## 日报命令

```sh
cd "$NEWSPAPER"
B=scratch/day-YYYY-MM-DD-run1
# 采集各群当天记录和图片描述，写入 $B/<日期>/group-N.input.json，见 pipeline/README.md
node "$BOT/scripts/prepare-week-d.mjs" generate FROM THROUGH "$B" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package FROM THROUGH "$B" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$B"
node "$BOT/scripts/apply-month-review.mjs" "$B" "$B/review.json"
node "$BOT/scripts/month-report.mjs" "$B"
node "$BOT/scripts/package-month-resources.mjs" "$B" --fetch
# 计算榜单快照，写入 $B/activity/，见 pipeline/README.md
# 预览和入库用 newspaper 仓库的脚本，见该仓库的 docs/publishing.md
```

### 输入

`$B/<日期>/group-N.input.json` 是一个群一天的本地消息，按北京时间整日截取，分页已读尽。分页状态只证明本次本地筛选读完，不证明微信全部历史都在本机。消息包含编号、化名、时间、正文和引用上下文。

图片消息的 `content` 仍是 `[图片]`，模型写的客观描述放在 `image` 字段。群稿和周报的生成器发给模型前，才把它换成 `[图片（缩略图）：描述]`。原始讨论面板从 `content` 取原话，仍显示 `[图片]`。缩略图描述可能认错小字和数字，审稿时不要把它当作已核实的事实。

### 1. 生成群稿

`prepare-week-d.mjs generate` 按群并行调用 `generate-daily-gemini.mjs`，用无工具的 Chat Completions 请求生成正文。

- 模型和端点统一在 `lib/llm.mjs`，都从环境变量读取：`DAILY_LLM_BASE_URL` 是任意 OpenAI 兼容端点（必填），`DAILY_LLM_MODEL` 是该端点上的模型名（默认 `gemini-4-argon`），`DAILY_LLM_API_KEY` 是密钥（端点需要时设置，不写入文件）。
- 生成前，先用最小请求确认模型能正常响应。
- 群稿请求带 `reasoning_effort: high`，`lib/llm.mjs` 的 `llmMaxOutputTokens` 固定为 32768。参考端点的历史行为见[操作手册的模型说明](../skill/references/runbook.md#模型)。换模型或端点时，应重新核对推理参数和输出上限，不沿用历史耗时或 token 用量作为保证。
- 脚本把 `length` 当作未完成处理；返回 `stop` 也不代替结构和内容检查。
- 初稿校验失败时，先带 `--repair-emphasis` 只修重点片段。问题不在重点时，脚本直接拒绝，不调用模型。仍然失败就整次重跑一遍，最终失败记入 `failures.json`。
- 原稿写成 `<群>.draft.json`。旁边的 `.run.json` 记录实际模型、调用方式、用量和耗时，不记录 prompt 或输入哈希。
- prompt 是 `prompts/daily-group.md`。带 `--emphasis` 时再拼上 `prompts/daily-emphasis.md`。批次目录里的 `prompt.md` 是实际发出的组合。
- `--resume` 复用已存在且通过当前输入校验的成功原稿。校验检查结构、证据 ID、资源链接和加粗要求，不检查 prompt 或输入是否改变。prompt 或输入改变时，用新的批次目录，或不带 `--resume`。

`prepare-week-d.mjs package` 只打包当天有读者版面的群（newspaper 仓库 `lib/groups.mjs` 的 `pageGroups`），生成 `issues.json`、`manifest.json` 和一份合并原稿，按运行记录标注实际模型。批次里已有 `headlines.json` 和 `comments.json` 时，它把报头和锐评合进 `issues.json`；`comments.json` 必须与本次打包的条目一一对应。生成稿通过结构检查，不表示已完成事实核验。

### 2. 补全锐评、报头和重点

`enrich-month-d.mjs` 每 5 期一组，调用 `generate-comments.mjs`、`generate-headlines.mjs` 和 `generate-emphasis.mjs` 生成 AI 锐评、报头和重点短语后合并。重点短语替换生成时同步选的加粗。

- 编辑仍要逐条审核重点，规则见 [编辑标准](../skill/references/editorial-standards.md)。
- 报头参考已审定的顺序，选能代表实质交流的主线，不必绑定第一条。
- 单独检查锐评，不要把不同人的经历拼成同一个事件或因果关系。
- 某一项失败时，单独重跑对应的 `generate-*.mjs`，再用 `--assemble` 合并。

### 3. 应用审稿

`apply-month-review.mjs` 按标题应用人工审稿的删除或改写。可以传多个审稿文件。结果记在 `review-applied.json`，模型原稿不覆盖。

审稿文件是数组。每项有 `date`、`group`、`title`、`evidenceIds`，再加 `drop`，或 `proposedTitle`、`proposedText`、`proposedComment`。不带 `title`、带 `heading` 或 `theme` 的项改该版报头。手机首屏要能看到第一段正文；报头和副题过长时，newspaper 仓库的 `test/mobile-navigation.mjs` 会失败。

审稿改正事实归属、时间、限定条件和隐私方面的错误。不要为了稳妥逐句加限定词，一处不确定只说一次。

### 4. 核对和资料

- `month-report.mjs` 核对输入的整日和分页字段，写出整理说明，并给空版填报头。它不能验证本机未同步的历史。群列表来自 `lib/groups.mjs`。
- `package-month-resources.mjs DIRECTORY [--fetch]` 要求显式批次目录，不带目录会报错。默认离线生成 `resources.json` 和 `resources-audit.json`；`--fetch` 才会访问链接。网页标题对应检查只是候选筛选，不代替主编读原文。
- `finalize-batch.mjs` 通过附件清单生成审核候选，再用独立回执批准确切候选，最后写入新的定稿目录。主编应核对正文、重点、锐评、资料和讨论；脚本不替主编批准内容，见[定稿接口](../docs/finalize.md)。

```sh
node "$BOT/scripts/finalize-batch.mjs" candidate --directory "$B" \
  --attachments "$B/attachments.json" --out "$B/candidate.json"
# 主编读完候选、原始证据和附件后，才能批准确切候选。
node "$BOT/scripts/finalize-batch.mjs" review --candidate "$B/candidate.json" \
  --reviewer "$REVIEWER" --approve --out "$B/review-receipt.json"
node "$BOT/scripts/finalize-batch.mjs" finalize --directory "$B" \
  --attachments "$B/attachments.json" --review "$B/review-receipt.json" --out "$B/final"
```

定稿输出与原始批次分开。后续使用 `$B/final/issues.json`，不再使用未定稿的 `$B/issues.json`。单日批次先把原日期目录复制到 `$B/final/<日期>/`，再对 `$B/final` 运行榜单和预览，具体步骤见[操作手册](../skill/references/runbook.md#4-活跃榜)。复制的原始输入仍是私有证据。榜单、头像和外部资讯还需分别审核，定稿成功不表示整期可以发布。

## 外部资讯

```sh
E=scratch/external-YYYY-MM-DD-run1
node "$BOT/scripts/collect-external.mjs" YYYY-MM-DD "$E"
node "$BOT/scripts/generate-external.mjs" "$E/selection.json" "$E/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$E/draft.json" "$E/commented-draft.json"
```

`collect-external.mjs` 只采集基础候选，补采、回原文和选题见 [资讯补查](../skill/references/external-sources.md)。审核回执和入库用 newspaper 仓库的 `scripts/review-external.mjs` 和 `scripts/import-external-report.mjs`，见该仓库的 `docs/external-news.md`。

## 周报

```sh
node "$BOT/scripts/generate-weekly-gemini.mjs" FROM THROUGH "$BATCH" "$BATCH/weekly-pages" [--groups group-1,...]
node "$BOT/scripts/generate-weekly-emphasis.mjs" "$BATCH/weekly-pages"
node "$BOT/scripts/weekly-discussion-evidence.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence"
node "$BOT/scripts/weekly-attach-discussions.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence" "$BATCH/discussion-audit.json"
node "$BOT/scripts/weekly-select-discussion.mjs" "$BATCH/reader/reader.json" "$BATCH/select" \
  --audit "$BATCH/discussion-audit.json"
```

- `generate-weekly-gemini.mjs` 的 prompt 是 `prompts/weekly-editor-gemini.md`。不传 `--groups` 时，它写这一周内任何一天有读者版面的全部群（`lib/groups.mjs` 的 `pageGroups`）。每个群只读它已开始采集（`from` 之后）的日期的输入。
- `generate-weekly-emphasis.mjs` 为 `lib/groups.mjs` 里各群的页面和 `external.json` 选重点。
- 讨论节选由后三个脚本生成：发言者按话题编号，消息 ID 和身份只留在私有审核文件里。筛选时传 `--audit`，使读者条目和私有审计同步，原有编号不重排。不传时脚本会提示，并清除无法核对的引用发言者，不凭文本猜身份。
- `weekly-attach-discussions.mjs` 可加 `--exclusions FILE`，在引用补齐之前应用已审核的排除项。清单格式、输入身份检查和审核约束见[周报流程](../skill/references/weekly.md#6-可复用执行链)。
- 审核后的读者稿用 newspaper 仓库的 `scripts/import-reviewed-weekly.mjs` 导入。

## 导览文案和单次模型调用

- `generate-bot.mjs DATA_JSON YYYY-MM-DD OUTPUT_MD [--notes FILE] [--site URL] [--preview]` 写一期日报的合并导览消息，prompt 是 `prompts/daily-bot.md`。
- `generate-weekly-bot.mjs ISSUE_JSON OUTPUT_MD [--base-url URL] [--split-dir DIR]` 按周报数据生成导览文案，不调用模型。
- `call-llm.mjs PROMPT_FILE OUTPUT [--system FILE] [--reasoning low|medium|high] [--max-tokens N]` 把一个 prompt 文件发给 `lib/llm.mjs` 的模型，供周报分片、修订等批次专用的调用使用。

## 当前 prompt 与历史实验

当前脚本静态使用根目录 `prompts/` 中的 8 份 prompt：`daily-group.md`、`daily-emphasis.md`、`daily-comment.md`、`daily-headline.md`、`daily-bot.md`、`weekly-editor-gemini.md`、`external-editor.md`、`image-description.md`。`generate-emphasis.mjs`、讨论筛选等脚本还包含内联指令。

5 个早期脚本已移到 `legacy/scripts/`；21 份 trial、`daily-editor.md`、`daily-reader-copy.md` 和其他手动编辑变体在 `legacy/prompts/`。这些文件保留作历史实验，不用于新刊期，细节见 [legacy 说明](../legacy/README.md)。当前仍在使用的 `prepare-week-d.mjs`、`enrich-month-d.mjs` 等脚本保留原名，文件名里的 week / month 不表示已经归档。

## 测试

在本仓库根目录运行 `NEWSPAPER_DIR=/path/to/newspaper npm test`。`scripts/test/` 的测试用本机的假模型端点，不调用真实模型。
