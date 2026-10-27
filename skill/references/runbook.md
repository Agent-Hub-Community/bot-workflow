# 操作手册

变量定义见 [SKILL.md](../SKILL.md#路径与环境变量)。下文里 `D` 是刊期日期（`YYYY-MM-DD`），`$BATCH` 是单日批次目录（如 `$NEWSPAPER/scratch/day-D-run1`），`$EXTERNAL` 是外部资讯目录。所有命令默认站在 `$NEWSPAPER` 目录下跑：`node scripts/…` 调的是 `newspaper` 的脚本，`node "$BOT/scripts/…"` 调的是 `bot-workflow` 的脚本。

## 1. 环境与模型配置

- 两个仓库放在同一个父目录下；如果不在一起，设好 `NEWSPAPER_DIR`。Node.js 最低 22.15，推荐 24。
- 群列表以 `$NEWSPAPER/lib/groups.mjs` 为唯一来源：`collectedGroups(D)` 是当天要采集并计入社区榜的群，`pageGroups(D)` 是当天固定出读者版面的主群，`optionalPageGroups(D)` 是有实质内容时才纳入日报和本日总览的垂类专项群（无内容时自动省略，不生成空版）。对应的微信群号 `<数字>@chatroom` 配在 `$PIPELINE/groups.private.mjs` 里。
- 生成脚本都从 `$BOT/lib/llm.mjs` 读配置：接口地址 `DAILY_LLM_BASE_URL`（脚本在末尾拼 `/chat/completions`），模型名 `DAILY_LLM_MODEL`（默认 `gemini-4-argon`），密钥 `DAILY_LLM_API_KEY`。需要单次调模型（比如周报分片或单条重写）时用 `node "$BOT/scripts/call-llm.mjs" PROMPT OUTPUT [--system FILE] [--reasoning high] [--max-tokens N]`。
- 写群稿开 `reasoning_effort: high`（大群跑一次约 4 到 5 分钟，多个群并行跑整批也是 5 分钟左右），输出上限 32768 token；外部资讯和周报不开推理。

## 2. 采集、写群稿与算活跃榜

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" "$D" "$D" "$BATCH"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-images.mjs" "$D" "$BATCH"
node "$BOT/scripts/prepare-week-d.mjs" generate "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$BATCH"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/prepare-release-activity.mjs" "$BATCH"
```

- 采集完看一眼各群条数。如果某群返回 0 条，确认是当天真没人说话还是客户端未同步。
- `collect-images.mjs` 把聊天图片解到 `$BATCH/$D/media/`，调视觉模型写客观描述，塞进 `group-N.input.json` 的 `image` 字段（按图片 md5 缓存在 `scratch/image-descriptions/`）。
- 初稿跑完后，按[编辑标准](editorial-standards.md)对照 `raw.json` 审稿：删掉水帖，拆开被硬并在一起的两件事，改掉张冠李戴、数字错误和隐私暴露。逐条检查 `emphasis` 下划线片段、资料链接和匿名讨论节选，直接更新 `$BATCH/issues.json`（或整理 `$BATCH/attachments.json`），跑一步校验：

```sh
node "$BOT/scripts/finalize-batch.mjs" "$BATCH"
```

（若使用独立的 `attachments.json`，传 `node "$BOT/scripts/finalize-batch.mjs" --directory "$BATCH" --attachments "$BATCH/attachments.json"`，它会校验并原地更新 `$BATCH/issues.json` 与 `$BATCH/final/issues.json`。）

- 检查 `$BATCH/activity/snapshot.json` 和 `avatar-review.json`。把每张新上榜成员的头像打开看一眼，确认正常、没有“暂时无法查看”占位图或不当图片后，清空 `avatar-review.json` 里的 `pending` 数组。

## 3. 外部资讯

先看[资讯补查](external-sources.md)和 `$NEWSPAPER/docs/external-news.md`。

```sh
node "$BOT/scripts/collect-external.mjs" "$D" "$EXTERNAL"
# 补扫其他来源、点开原文核实后整理出 $EXTERNAL/selection.json
node "$BOT/scripts/generate-external.mjs" "$EXTERNAL/selection.json" "$EXTERNAL/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$EXTERNAL/draft.json" "$EXTERNAL/commented-draft.json"
```

`collect-external.mjs` 只抓基础热榜，中间要把必查来源补齐、点开原文核实时间和数字，写出 `selection.json`。审稿修订后的终稿存为 `$EXTERNAL/commented-draft.json`（或 `reviewed-final.json`）。

## 4. 本地预览与导览草稿

直接对 `$BATCH` 跑预览（无需把日期目录来回拷进 `final/`）：

```sh
node scripts/prepare-preview.mjs --date "$D" --batch "$BATCH" \
  --external-draft "$EXTERNAL/commented-draft.json" --external-selection "$EXTERNAL/selection.json"
node "$BOT/scripts/generate-bot.mjs" "$BATCH/final-reader-issue.json" "$D" "$BATCH/bot-preview.md" --preview
```

以 `$BATCH/preview` 为根目录起本地静态服务，在手机（375px）和桌面（1440px）宽度下抽检当天版面、重点下划线、资料卡片、讨论弹窗和榜单。

如果本轮只做预览，把 `$BATCH/bot-preview.md` 拷到 `$REPORTS/D-AgentHub导览草稿.md` 即可交付。

## 5. 正式入库与部署（获准发布后）

拿到用户对本期发布的同意后，直接入库、构建并登记反馈与向量：

```sh
node scripts/publish-reviewed-batch.mjs "$BATCH"
node scripts/import-external-report.mjs "$EXTERNAL/commented-draft.json" "$EXTERNAL/selection.json"
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
node scripts/embed-catalog.mjs
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
npm test
node test/build.mjs --public
```

往 Cloudflare D1 登记新增条目的赞踩 ID（保留旧票数，只做 `INSERT OR IGNORE`）：

```sh
node scripts/feedback-catalog.mjs dist/data.js "$BATCH/feedback-catalog.sql"
"$WRANGLER_BIN" d1 execute agenthub-feedback --remote --config feedback/wrangler.jsonc --file "$BATCH/feedback-catalog.sql"
```

核对 `git status` 和 `git diff`，确认只改动了本期授权的 `data/` 文件（不含 `scratch/` 或私有文件），提交并推送到 `main`。

等 GitHub Actions Pages 部署跑完后，生成正式上线版导览文案：

```sh
node "$SKILL_DIR/scripts/verify-publication.mjs" \
  --newspaper "$NEWSPAPER" --site "$SITE" --date "$D" --out "$BATCH/publication-check.json"
node "$BOT/scripts/generate-bot.mjs" "$BATCH/publication-check.json.data.json" "$D" "$BATCH/published-bot.md"
```

复核无误后拷到 `$REPORTS/D-AgentHub导览草稿.md` 交付给用户，注明导览只是草稿、尚未发群，并顺带提一句资料库和黑话词典距离上次更新隔了几天。

### 修旧刊期

只改往期某篇文案时：直接改 `data/editions/<date>.json`（或重新跑 `import-external-report.mjs`），不动 `data/public-activity/`，不调 `publish-reviewed-batch.mjs`，免得把社区榜截止日倒退回旧日期。
