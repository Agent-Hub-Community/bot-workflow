# 操作手册

变量定义见 [SKILL.md](../SKILL.md#路径与环境变量)。下文里 `D` 是刊期日期（`YYYY-MM-DD`），`$BATCH` 是单日批次目录（如 `$NEWSPAPER/scratch/day-D-run1`），`$EXTERNAL` 是外部资讯目录。所有命令默认站在 `$NEWSPAPER` 目录下跑：`node scripts/…` 调的是 `newspaper` 的脚本，`node "$BOT/scripts/…"` 调的是 `bot-workflow` 的脚本。

## 1. 开跑前检查

- 两个仓库放在同一个父目录下；如果不在一起，设好 `NEWSPAPER_DIR`。Node.js 最低 22.15，推荐 24。
- 看一眼两个仓库的 `git status` 和当前分支，别把别的未提交改动混进来。
- 试一下 `HOME="$WX_HOME" wx sessions --json -n 20` 能不能列出目标群。如果密钥过期或缓存坏了，由运行者本人按 `bot-workflow/docs/collection.md` 处理，agent 不自己跑 `sudo` 或重启微信。
- 群列表以 `$NEWSPAPER/lib/groups.mjs` 为唯一来源：`collectedGroups(D)` 是当天要采集并计入社区榜的群，`pageGroups(D)` 是当天要出读者版面的群。对应的微信群号 `<数字>@chatroom` 和运营号哈希配在 `$PIPELINE/groups.private.mjs` 里。

### 模型与接口经验

生成脚本都从 `$BOT/lib/llm.mjs` 读配置：接口地址 `DAILY_LLM_BASE_URL`（脚本在末尾拼 `/chat/completions`），模型名 `DAILY_LLM_MODEL`（默认 `gemini-4-argon`），密钥 `DAILY_LLM_API_KEY`。

- 跑命令时从密钥管理工具临时注入 `DAILY_LLM_API_KEY`，不要把密钥写进仓库文件或打到终端里。
- 开跑前先发一个最小请求，确认接口通畅、返回的模型名对得上。需要单次调模型（比如周报分片或单条重写）时用 `node "$BOT/scripts/call-llm.mjs" PROMPT OUTPUT [--system FILE] [--reasoning high] [--max-tokens N]`。

下面是我们在参考端点上用 `gemini-4-argon` 跑出来的经验（2026 年 10 月）：

- 写群稿开 `reasoning_effort: high`。大群跑一次大约 4 到 5 分钟，输出 2 万到 3 万 token（多个群并行跑整批也是 5 分钟左右）。不开推理时，模型容易把几段不挨着的话题硬揉成一条。这个模型只有设 `high` 才会真正推理，设 `low` 或 `medium` 等于没开。
- 端点单次输出上限是 32768 token（思考 token 也算在内），`lib/llm.mjs` 固定按这个值传。如果某群报 `finish_reason: length`，说明思考把预算吃光了，重跑一次即可。
- 外部资讯和周报不开推理。
- 模型摘抄原文做 `emphasis` 时，偶尔会差一两个字。`prepare-week-d.mjs` 会先自动加 `--repair-emphasis` 修一次；外部资讯脚本则会把对不上的片段剔掉，记在 `.run.json` 的 `emphasisTrimmed` 里，审稿时手动补上就行。

## 2. 群稿、报头与锐评

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" "$D" "$D" "$BATCH"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-images.mjs" "$D" "$BATCH"
node "$BOT/scripts/prepare-week-d.mjs" generate "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$BATCH"
```

一步步跑、一步步看输出，别贴成一整坨盲跑。

- 采集完先看各群的条数、首末时间和分页状态。翻到尾页只代表本机库里的记录读完了，不代表微信全量历史都在这台电脑上；如果某群返回 0 条，先去微信客户端看看是不是真没人说话、还是主聊天库密钥没扫出来。
- `collect-images.mjs` 把聊天图片解到 `$BATCH/$D/media/`，调视觉模型写客观描述，塞进 `group-N.input.json` 的 `image` 字段（按图片 md5 缓存在 `scratch/image-descriptions/`）。写稿时模型看得到这段图说，而原始讨论面板只展示 `[图片]`。关键图片如果只有模糊缩略图，请运行者在微信里点开该群滑过原图，再重跑一次 `collect-images.mjs`。
- 初稿跑完后，按[编辑标准](editorial-standards.md)对照 `raw.json` 审稿：删掉水帖，拆开被硬并在一起的两件事，改掉张冠李戴、数字错误和隐私暴露。删改意见写进 `$BATCH/review.json`，依次跑：

```sh
node "$BOT/scripts/apply-month-review.mjs" "$BATCH" "$BATCH/review.json"
node "$BOT/scripts/month-report.mjs" "$BATCH"
node "$BOT/scripts/package-month-resources.mjs" "$BATCH" --fetch
```

- 接着逐条检查 `emphasis` 下划线片段、资料链接和原始讨论节选，整理成 `$BATCH/attachments.json`，用 `finalize-batch.mjs` 的三步命令签出终稿（详细字段见 `$BOT/docs/finalize.md`）：

```sh
node "$BOT/scripts/finalize-batch.mjs" candidate \
  --directory "$BATCH" --attachments "$BATCH/attachments.json" --out "$BATCH/candidate.json"
node "$BOT/scripts/finalize-batch.mjs" review \
  --candidate "$BATCH/candidate.json" --reviewer "$REVIEWER" --approve --out "$BATCH/review-receipt.json"
node "$BOT/scripts/finalize-batch.mjs" finalize \
  --directory "$BATCH" --attachments "$BATCH/attachments.json" --review "$BATCH/review-receipt.json" --out "$BATCH/final"
```

注意：只要后面又动了正文、锐评、重点、资料或讨论，旧回执就会作废，需要重新跑一遍定稿。

## 3. 外部资讯

先看[资讯补查](external-sources.md)和 `$NEWSPAPER/docs/external-news.md`。

```sh
node "$BOT/scripts/collect-external.mjs" "$D" "$EXTERNAL"
# 补扫其他来源、点开原文核实后整理出 $EXTERNAL/selection.json
node "$BOT/scripts/generate-external.mjs" "$EXTERNAL/selection.json" "$EXTERNAL/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$EXTERNAL/draft.json" "$EXTERNAL/commented-draft.json"
```

`collect-external.mjs` 只抓基础热榜，不能抓完直接喂给生成脚本——中间必须把必查来源补齐、点开原文核实时间和数字，写出 `selection.json`。

如果需要返工传第三个参数（审稿意见文件），注意两个脚本的脾气不一样：

- `generate-external.mjs` 带审稿意见时会直接读取并改写输出路径上的旧稿；想保留原稿就先把旧稿拷到新文件名再跑。
- `generate-external-comments.mjs` 的输出路径则必须是新文件，不能先把输入拷过去。

审完并拿到本期发布同意后，签发外部资讯回执并导入 `data/external-editions/`：

```sh
node scripts/review-external.mjs "$FINAL" "$EXTERNAL/selection.json" "$EXTERNAL/review-record.json" "$REVIEWER" --approve
node scripts/import-external-report.mjs "$FINAL" "$EXTERNAL/selection.json" "$EXTERNAL/review-record.json"
```

## 4. 活跃榜

定稿之后的步骤统一基于 `$BATCH/final` 跑。`prepare-release-activity.mjs` 需要读取同目录底下的日期目录，先把 `$BATCH/$D` 拷过去（拷之前看一眼，别重复嵌套拷贝）：

```sh
RELEASE_BATCH="$BATCH/final"
test ! -e "$RELEASE_BATCH/$D" && cp -R "$BATCH/$D" "$RELEASE_BATCH/$D"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/prepare-release-activity.mjs" "$RELEASE_BATCH"
BATCH="$RELEASE_BATCH"
```

跑完检查 `$BATCH/activity/snapshot.json` 和 `avatar-review.json`。把每张新上榜成员的头像打开看一眼，确认正常、没有“暂时无法查看”占位图或不当图片后，再清空 `avatar-review.json` 里的 `pending`。

## 5. 本地预览与页面验收

```sh
node scripts/prepare-preview.mjs --date "$D" --batch "$BATCH" \
  --external-draft "$EXTERNAL/reviewed-final.json" --external-selection "$EXTERNAL/selection.json" \
  --base "http://127.0.0.1:$PORT/newspaper"
```

`prepare-preview.mjs` 会调 `build.mjs` 生成预览，核对构建结果与定稿数据、榜单快照完全一致，再把静态页面拷到 `$BATCH/preview/newspaper/`。以 `$BATCH/preview` 为根目录起本地静态服务即可预览。

验收重点：

- 逐版打开当天各群、外部资讯和周／月／总榜页面。
- 在 320px、390px、700px/701px（单双列断点）、820px 和 1440px 宽度下看实际渲染：页签不挤出屏幕、标题和正文不重叠、头像能正常显示、重点下划线和资料卡片都在、长图导出正常。
- 点开“原始讨论 N 条 · M 人”浮窗，确认桌面双栏、平板侧滑、手机全屏都能正常打开和关掉。可以跑：

```sh
VERIFY_SITE="http://127.0.0.1:$PORT/newspaper" DISCUSSION_DATE="$D" node test/discussion-browser.mjs
```

## 6. 正式入库与部署（获准发布后）

拿到用户对本期发布的同意后，先重跑一次 `finalize-batch.mjs finalize` 确认 `$BATCH` 内容与回执没有走样，再入库构建：

```sh
node scripts/publish-reviewed-batch.mjs "$BATCH"
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
node scripts/embed-catalog.mjs
npm test
node test/build.mjs --public
```

接着往 Cloudflare D1 登记新增条目的赞踩 ID（保留旧票数，只做 `INSERT OR IGNORE`）：

```sh
node scripts/feedback-catalog.mjs dist/data.js "$BATCH/feedback-catalog.sql"
"$WRANGLER_BIN" d1 execute agenthub-feedback --remote --config feedback/wrangler.jsonc --file "$BATCH/feedback-catalog.sql"
```

核对 `git status` 和 `git diff`，确认只改动了本期授权的 `data/` 文件（不含 `scratch/`、原文或私有审计），提交并推送到 `main`。等这次提交对应的 GitHub Actions Pages 部署跑完后，运行线上核验器：

```sh
node "$SKILL_DIR/scripts/verify-publication.mjs" \
  --newspaper "$NEWSPAPER" --site "$SITE" --date "$D" --out "$BATCH/publication-check.json"
```

核验器会从线上拉回 `data.js` 和 `issues/D.js` 与本地 `dist/` 逐字节比对，并输出合并后的 `publication-check.json.data.json` 供下一步写导览文案。

### 修旧刊期与补报老日期

- 只改往期某篇文案：直接改 `data/editions/<date>.json`（或重新导入外部资讯），不动 `data/public-activity/`，不调 `publish-reviewed-batch.mjs`，免得把社区榜截止日倒退回旧日期。核验时传 `--rank-through <当前线上最新的榜单日期>`。
- 补发以前漏掉的某一天：当前 `publish-reviewed-batch.mjs` 要求榜单截止日等于发布日，不能直接拿它发老日期；需要先确认不会冲掉现有最新社区榜和历史日榜再入库。

## 7. 导览文案与交付

导览文案是准备发到微信群里的一条合并消息，全篇不留空行：首行写完紧接第一个版面，每个版面一段话（70 到 90 字，点出主线和一两个看点）配一行链接，没有稿件的群直接略过。

```sh
# 仅本地预览时：
node "$BOT/scripts/generate-bot.mjs" "$BATCH/final-reader-issue.json" "$D" "$BATCH/bot-preview.md" --preview

# 正式上线并核验通过后：
node "$BOT/scripts/generate-bot.mjs" "$BATCH/publication-check.json.data.json" "$D" "$BATCH/published-bot.md" [--notes "$BATCH/bot-notes.md"]
```

如果有模型容易搞错的细节（比如“某产品只是预告、还没开卖”），写进 `--notes` 提醒它；别往 `--notes` 里塞“尚非定论”“有待验证”之类的套话，不然模型会原样抄进导览里。

复核无误后拷到 `$REPORTS/D-AgentHub导览草稿.md`，连同 `$REPORTS/D-AgentHub日报.md` 一并交付给用户，写明导览只是草稿、尚未发群，并顺口报一下资料库和黑话词典距离上次更新隔了几天。

## 8. 进度记录（`workflow.json`）

在 `$BATCH/workflow.json` 里顺手记一下当前跑到了哪一步（`collect` → `editorial` → `activity` → `preview` → `publish` → `live` → `delivery`）、用的起止窗口、两个仓库的 base SHA 和阻塞原因，方便中断后续跑。
