# 周报流程（Antigravity 原生版）

周报按北京时间自然周（周一 `00:00` 到下周一 `00:00`）整理一周的内容：每个有周报版面的群各占一版，外加一周外部资讯和各群独立周榜，顺带做一次资料库、机会和黑话的周增量。全程由 Antigravity（Gemini）及并行子任务（T3 Code 优先用 `delegate_task`，非 T3 环境用 `invoke_subagent`）完成，无外部 LLM API，无人工二轮审核。

## 1. 定时间窗口与批次目录

```sh
node "$BOT/skill/scripts/weekly-window.mjs"
node "$BOT/skill/scripts/weekly-window.mjs" --from 2026-10-19 --through 2026-10-25
```

批次目录放在 `$NEWSPAPER/scratch/weekly-FROM_THROUGH-runN/`（记作 `$BATCH`）。

## 2. 准备七天群聊输入、解图与周榜

可复用平时日报已采好的 `<date>/<group>.input.json` / `raw.json`，缺的日期补采并解图，再算各群周榜：

```sh
node "$PIPELINE/collect-batch.mjs" FROM THROUGH "$BATCH"
for d in FROM … THROUGH; do node "$PIPELINE/collect-images.mjs" "$d" "$BATCH"; done
node "$PIPELINE/prepare-weekly-rank.mjs" "$BATCH"
```

## 3. 并行派发子任务写各群周报与外部资讯

在 T3 Code 环境下先调用一次 `orchestrator_capabilities`，然后在一个 turn 里并行调用 `delegate_task`（`mode: "async"`、`target: { providerInstanceId: "antigravity", model: "gemini-4-neon" }`；非 T3 环境且在 `summary_bot` 工作区时改用 `invoke_subagent` `TypeName: "self"`）：

- **每个群 1 个 subagent**（`weeklyGroups(THROUGH)` 里的 `group-1`..`group-8`）：
  - 读 `$BOT/prompts/weekly-editor.md` 和该群七天的 `<date>/<group>.input.json`（有图直接 `read_file` 看 `$BATCH/<date>/media/<group>/`）。
  - 跨日串联同一个问题，单日扎实话题单独成条。
  - 直接写出两份文件：
    1. `$BATCH/review/<group>.page.json`：`{ title, intro, stories: [{ title, text, review, emphasis, dates, kind, timeline, resources }] }`
    2. `$BATCH/evidence/<group>.evidence.json`：`{ "group": "<group>", "evidence": { "0": ["YYYY-MM-DD:m0012", ...] } }`（每条故事对应的原始消息 ref 列表，复读刷屏只留一两条代表，其余跑题消息不收）。
- **1 个外部资讯 subagent**：汇总本周行业大事、重要发布与论文，核实一手来源后直接写出 `$BATCH/external-page.json`。

## 4. 组装周报、挂载讨论媒体与链接预览

```sh
node "$BOT/scripts/assemble-weekly-reader.mjs" "$BATCH" --from FROM --through THROUGH
node "$BOT/scripts/weekly-attach-discussions.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence" "$BATCH/discussion-audit.json"
```

`weekly-attach-discussions.mjs` 会自动把入选讨论里由 `collect-images.mjs` 解码优化好的图片（WebP + 宽高）、视频（faststart MP4）与 ≤10 MB 文件复制到 `$BATCH/attachments/` 并挂载到 `story.discussion`。

## 5. 增量更新资料库、机会与黑话（可选）

按上次各自 `through` 的次日补到本周日：

```sh
node "$PIPELINE/collect-library-candidates.mjs" --since <library 的 through 次日>
node "$PIPELINE/collect-opportunity-candidates.mjs" --since <opportunities 的 through 次日>
node "$PIPELINE/collect-glossary-chunks.mjs" --since <glossary 的 through 次日>
```

由 Antigravity subagent 整理成对应 JSON 后，分别运行 `assemble-library.mjs`、`assemble-opportunities.mjs` 并更新 `data/glossary.json`。

## 6. 写周报导览、本地构建与发布

主 agent 根据 `$BATCH/reader/reader.json` 和 `$BOT/prompts/daily-bot.md` + `$BOT/prompts/weekly-bot.md` 直接写出 `$REPORTS/FROM_THROUGH-AgentHub周报导览草稿.md`。

本地验收与入库（同步增量抓取周报新增链接预览）：

```sh
node scripts/import-reviewed-weekly.mjs "$BATCH/reader"
node "$BOT/scripts/fetch-link-previews.mjs"
npm run build
```

获准发布后执行：

```sh
node scripts/release.mjs
```

核对 `git status` 只改了 `data/` 后提交推送，等待 GitHub Actions 部署完成。
