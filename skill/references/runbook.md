# 操作手册

变量定义见 [SKILL.md](../SKILL.md#路径与环境变量)。下文里 `D` 是刊期日期（`YYYY-MM-DD`），`$BATCH` 是单日批次目录（如 `$NEWSPAPER/scratch/day-D-run1`），`$EXTERNAL` 是外部资讯目录。所有命令默认在 `$NEWSPAPER` 目录下运行：`node scripts/…` 调用 `newspaper` 的脚本，`node "$BOT/scripts/…"` 调用 `bot-workflow` 的脚本。

## 1. 环境与模型配置

- 两个仓库放在同一个父目录下；如果不在一起，设好 `NEWSPAPER_DIR`。Node.js 最低 22.15，推荐 24。
- 群列表只以 `$NEWSPAPER/lib/groups.mjs` 为准：`collectedGroups(D)` 是当天要采集并计入社区榜的群，`pageGroups(D)` 是当天固定出读者版面的主群，`optionalPageGroups(D)` 是有实质内容时才纳入日报的垂类专项群。对应的微信群号配在 `$PIPELINE/groups.private.mjs` 里。
- 生成脚本都从 `$BOT/lib/llm.mjs` 读配置：`DAILY_LLM_BASE_URL`（脚本在末尾拼 `/chat/completions`）、`DAILY_LLM_MODEL`（默认 `gemini-4-argon`）、`DAILY_LLM_API_KEY`。单次调用模型用 `node "$BOT/scripts/call-llm.mjs" PROMPT OUTPUT [--system FILE] [--reasoning high] [--max-tokens N]`。
- 写群稿时开 `reasoning_effort: high`，大群一次约 4 到 5 分钟；外部资讯和周报不开推理。
- 跑 `bot-workflow` 的 `npm test` 时，不要带本机为长请求加的 `NODE_OPTIONS` 加载器：它会接管模型请求，测试里的假模型接口就失效了。

## 2. 准备：一条命令

```sh
node "$BOT/scripts/daily.mjs" prepare "$D"
```

这条命令按下面的顺序编排，每步日志写在 `$BATCH/logs/`：

| 顺序 | 步骤 | 读微信库 |
|---|---|---|
| 1 | `collect-batch` 导出整日消息 | 是 |
| 2 | `collect-images` 解图并写图片描述 | 是 |
| 并行 | `collect-external` 外部资讯基础候选 | 否 |
| 3 | `prepare-week-d generate/package --emphasis` + `enrich-month-d` 写初稿、报头、锐评、重点 | 否 |
| 4 | `prepare-release-activity` 活跃榜 | 是 |

- 读库的三步串行执行，同一个微信账号的数据库不能并发读取。
- 群聊主线某一步失败时命令停止，并提示从哪一步续跑（`--from-step`）；续跑写稿时只重跑没通过的群。外部资讯抓取失败只告警，不停主线，结束时给出单独重跑的命令。`--dry-run` 只打印计划。
- 采集一完成就打印各群条数，结束时再汇总一次，并提示还有几张新头像待看。某群 0 条时，比对本地消息编号和会话列表的最后时间：如果都停在前一天，可以按“本地无记录”处理；如果怀疑是同步缺口，请用户在微信里滚动到该日后重采。

## 3. 审稿与落改

### 3.1 群稿

每个有稿的群交给一个编辑（人或 agent）。编辑对照 `$BATCH/D/<group>.input.json` 和同序的 `raw.json`，只查[编辑标准](editorial-standards.md)列出的六类硬伤，并看有没有漏掉的实质话题。编辑不写错误清单，直接写审稿补丁：

```json
{ "pages": { "group-4": {
  "heading": "可选，新报头",
  "stories": [
    { "index": 0, "text": "改好的完整正文", "emphasis": ["正文里逐字出现的片段"],
      "discussion": { "first": "m0094", "last": "m0189", "drop": ["m0138"] },
      "resources": [{ "kind": "paper", "label": "论文名", "url": "https://..." }] },
    { "index": 1, "replace": [{ "field": "text", "find": "原文片段", "replace": "新片段" }],
      "discussion": { "first": "m0066", "last": "m0091", "drop": [] } },
    { "new": true, "category": "…", "title": "…", "text": "…", "emphasis": [], "aiComment": "…",
      "discussion": { "first": "m0190", "last": "m0238", "drop": [] }, "resources": [] }
  ] } } }
```

```sh
node "$BOT/scripts/apply-review.mjs" "$BATCH" "$BATCH"/review/group-*.patch.json
node "$BOT/scripts/finalize-batch.mjs" "$BATCH"
```

- 每群一份补丁，一次全部传入；两份补丁改同一条稿子会报冲突。`index` 指初稿里的下标。
- 第一次运行时，脚本把初稿备份为 `issues.pre-review.json`；以后每次都从这份备份重新打补丁，所以改完补丁直接重跑即可，改动不会叠加。
- 如果在落改之后又重新生成了 `issues.json`，脚本会报错，不会覆盖新稿。确认后加 `--rebase`，以当前稿为新基线。

- `apply-review.mjs` 按消息区间截取讨论节选：发言人编成“群友 N”，原始正文和正文里的 `@昵称` 原样保留，引用头换成编号，图片只留 `[图片]`，短复读最多留两次。
- `replace` 的 `find` 必须在字段里唯一出现。改完正文后，对不上的重点片段会被自动丢掉，并打印出来。
- 资料链接只收群里出现过、并且亲自打开核实过的公开链接。
- 日报不再另设逐条复核人。编辑没把握的地方，回到原文再查一次，不要靠第二个人兜底。

### 3.2 头像

`prepare-release-activity` 会自动剔除“暂时无法查看”占位图（哈希表在 `$NEWSPAPER/lib/avatar-placeholders.mjs`），名次保留但不显示头像。剩下的新头像拼成一张图，一次看完：

```sh
cd "$BATCH/activity" && node -e 'console.log(require("./avatar-review.json").pending.join("\n"))' > /tmp/av.txt \
  && montage @/tmp/av.txt -tile 6x -geometry 160x160+6+6 /tmp/avatars.png
```

只排除未成年人照片和不当图片。看完后清空 `pending`。遇到新的占位图样式，把它的 MD5 加进哈希表。

## 4. 外部资讯

先看[资讯补查](external-sources.md)。

```sh
# daily.mjs prepare 已跑过 collect-external；补扫其他来源，先挑出要用的条目，只核实入选条目
node "$BOT/scripts/generate-external.mjs" "$EXTERNAL/selection.json" "$EXTERNAL/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$EXTERNAL/draft.json" "$EXTERNAL/commented-draft.json"
```

审稿只改错（繁体字、数字、来源对不上）。终稿存为 `$EXTERNAL/reviewed-final.json`。

## 5. 本地预览与导览草稿

```sh
node scripts/prepare-preview.mjs --date "$D" --batch "$BATCH" \
  --external-draft "$EXTERNAL/reviewed-final.json" --external-selection "$EXTERNAL/selection.json"
node "$BOT/scripts/generate-bot.mjs" "$BATCH/final-reader-issue.json" "$D" "$BATCH/bot-preview.md" --preview
```

以 `$BATCH/preview` 为根目录起本地静态服务，在 375px 和 1440px 下抽检当天版面、重点下划线、讨论弹窗和榜单。只做预览时，把 `bot-preview.md` 拷到 `$REPORTS/D-AgentHub导览草稿.md` 交付。

## 6. 发布（获准后）

```sh
node scripts/release.mjs --daily-batch "$BATCH" \
  --external-draft "$EXTERNAL/reviewed-final.json" --external-selection "$EXTERNAL/selection.json" \
  --sql-out "$BATCH/feedback-catalog.sql"
```

`release.mjs` 依次完成：日报与榜单入库、外部资讯入库、公开构建、语义向量、再次公开构建、`npm test`、`test/build.mjs --public`、生成反馈目录 SQL、在 D1 执行。D1 只接受全为 `INSERT OR IGNORE` 的 SQL，已有票数不变。任何一步失败都会停止，并打印失败的是哪一步。它不提交、不推送；最后打印改动目录汇总。

然后：

1. 核对 `git status`：只应改动 `data/`。头像换了公开编号时，git 会显示删除加新增，这是正常的；脚本已校验历史日榜不变。
2. 提交并推送到 `main`，等 GitHub Actions 部署成功。
3. 生成上线版导览：

```sh
node "$SKILL_DIR/scripts/verify-publication.mjs" \
  --newspaper "$NEWSPAPER" --site "$SITE" --date "$D" --out "$BATCH/publication-check.json"
node "$BOT/scripts/generate-bot.mjs" "$BATCH/publication-check.json.data.json" "$D" "$BATCH/published-bot.md"
```

把 `published-bot.md` 拷到 `$REPORTS/D-AgentHub导览草稿.md` 交给用户，注明导览没有发群，并说明资料库和黑话词典距离上次更新隔了几天。

### 修旧刊期

只改往期某篇文案时，直接改 `data/editions/<date>.json`（或重新跑 `import-external-report.mjs`）。不要动 `data/public-activity/`，不要调用 `publish-reviewed-batch.mjs`，否则社区榜的截止日会倒退回旧日期。
