---
name: agenthub-daily
description: "基于 Antigravity（Gemini）与并行子任务（T3 Code `delegate_task` / `invoke_subagent`）生成 Agent Hub 社区日报或周报：一条本地命令完成微信采集、图片解码、活跃榜和外部资讯候选抓取，随后并行派发子任务直接写各群定稿和外部资讯，自动挂载图片/视频/文件到讨论记录，本地预览并在获准后发布上线。"
---

# Agent Hub 日报与周报（Antigravity 原生流程）

整套流程完全由 **Antigravity（Gemini）及其并行子任务**驱动，**不再依赖任何外部 HTTP 模型 API**（无 `argon` / `gpt-6-luna` / `magpie` / `coproxy` / `DAILY_LLM_*`），也**不再做内容审核、隐私审查或二轮审稿补丁**。脚本只做确定性的本地读写、图片解码、媒体挂载、静态构建和发布。

> **子任务派发规范（重要）**：
> - 在 **T3 Code** 环境下（尤其当对话工作区不是 `/Users/haoqing/Documents/Github/summary_bot` 时），**优先使用 T3 Code 的 `delegate_task`**（先调一次 `orchestrator_capabilities`，再并行派发 `mode: "async"`、`target: { providerInstanceId: "antigravity", model: "gemini-4-neon", options: { thought_level: "low" } }` 的子任务）。原因是 Antigravity 原生 `invoke_subagent` 在读写当前工作区之外的路径（如 `$NEWSPAPER/scratch`）时会触发底层权限拦截且无法透传到 T3 UI，导致子 agent 卡死；而 `delegate_task` 继承 T3 会话的 `full-access` 权限，跨目录读写无阻碍且在 UI 中可独立观测进度。设为 `thought_level: "medium"`（且提示分批读图、每次 6–8 张）可避免重图大群或外部资讯单步思考超 20 分钟触发上游断线。
> - 仅在没有 `delegate_task` 工具且工作区位于 `/Users/haoqing/Documents/Github/summary_bot` 时，回退到原生 `invoke_subagent`（`TypeName: "self"`）。
> - 消息很少的小群/专项群（如合计不足 60 条的 `group-2`/`group-7`/`group-8`）可合并给 1 个子任务一起写，补跑多天时注意总并发不超过 `maxBatchThreads`（20）。

## 路径与环境变量

先加载本机环境：`source /Users/haoqing/Documents/Github/summary_bot/config/daily-env.sh`。

| 变量 | 含义 |
|---|---|
| `$NEWSPAPER` | `newspaper` 仓库根目录（日常命令默认站在这里跑） |
| `$BOT` | `bot-workflow` 仓库根目录 |
| `$PIPELINE` | `$BOT/pipeline`，本地微信采集、解图和活跃榜脚本 |
| `$REPORTS` | 导览草稿输出目录 |
| `$BATCH` | 单日批次目录，默认 `$NEWSPAPER/scratch/day-D-runN` |
| `$EXTERNAL` | 外部资讯目录，默认 `$NEWSPAPER/scratch/external-D-runN` |
| `$SITE` | 线上地址 `https://agent-hub-community.github.io/newspaper/` |

`D` 是刊期日期（`YYYY-MM-DD`，默认取上一个完整的北京时间自然日）。
- **最新一期（昨日刊 `D`）的时间窗**：默认开启 `--through-now`，不再卡死在昨日 24:00，而是从 **昨日 `00:00` 一直采集到生成当时**（覆盖昨日完整一天 + 今日 00:00 至生成时刻），页面注记自动显示 `截至北京时间 MM-DD HH:MM`；历史补跑期（早于昨日）仍按完整自然日 `00:00–24:00` 采集（也可手动加 `--through-now` 或 `--strict-day` 覆盖）。

## 用户常见说法与执行范围

| 用户怎么说 | 做到哪一步 |
|---|---|
| “跑一下昨日日报” / “生成日报” | 跑完采集、并行 subagent 写群稿和外部资讯、自动挂载媒体、本地预览和导览草稿，不推上线。 |
| “生成并发布昨日日报” | 一路做到入库、推送部署和上线版导览，中间不停下来问。 |
| “上线吧” / “推上去呗” | 把本轮做好的那期直接 `daily.mjs publish`，不重采、不重写。 |
| “来一下周报” | 按[周报流程](references/weekly.md)由并行 subagent 完成各群周报、外部资讯、周榜和预览。 |
| “只改某条 / 标题 / 锐评” | 直接改对应 `draft.json` 或 `data/editions/<date>.json`，重跑 `finish` 或构建，不重采。 |

“发布／上线”只允许更新网站仓库和 D1 反馈库，**不代表往微信群发消息**。

## 日报 4 步流程

命令细节见[操作手册](references/runbook.md)，写作风格见[写作标准](references/editorial-standards.md)。

1. **采集与解图（1 条命令，零模型调用，约 10–15 秒）**
   ```sh
   source /Users/haoqing/Documents/Github/summary_bot/config/daily-env.sh
   node "$BOT/scripts/daily.mjs" collect "$D"
   ```
   串行完成 `collect-batch`（导出各群聊天）→ `collect-images`（纯本地解 `.dat` 图到 `$BATCH/$D/media/<group>/`）→ `prepare-release-activity`（算活跃榜并自动过滤微信占位头像），同时并行抓取外部资讯基础候选（`collect-external`）。

2. **并行派发子任务一步出稿**
   在一个 turn 里并行调用 `delegate_task`（T3 Code 环境，先调一次 `orchestrator_capabilities`，以 `mode: "async"`、`target: { providerInstanceId: "antigravity", model: "gemini-4-neon" }` 派发；无 T3 工具且位于 `summary_bot` 工作区时改用 `invoke_subagent`）：
   - **每个有较多消息的群各派 1 个子任务**（`group-1`..`group-8`，消息很少的群/专项群可合并为 1 个子任务）：读 `$BOT/prompts/daily-group.md`、`$BOT/prompts/daily-comment.md`、`$BATCH/$D/<group>.input.json`、同目录 `raw.json`，并直接用 `read_file` 查看 `$BATCH/$D/media/<group>/` 下解出的图片，一次性写出完成版 `$BATCH/$D/<group>.draft.json`（含 `heading`、`theme`、`stories`、`emphasis`、`aiComment`、`evidence_ids` / `discussion_range`、`resources`、`image_alts`），写完用 `node` 自检 JSON 合法性。
   - **同时派 1 个外部资讯子任务**：读 `$EXTERNAL/discovery.json`、[资讯补查](references/external-sources.md)、`$BOT/prompts/external-editor.md` 和 `$BOT/prompts/daily-comment.md`，核实一手原文后直接写出 `$EXTERNAL/selection.json` 和 `$EXTERNAL/reviewed-final.json`（自带 `emphasis` 和 `aiComment`），写完用 `node` 校验 JSON 与链接一致。

3. **打包、自动挂载媒体与本地预览（1 条命令）+ 写导览**
   ```sh
   node "$BOT/scripts/daily.mjs" finish "$D" --batch "$BATCH" --external "$EXTERNAL"
   ```
   自动打包 `issues.json`、把已解图片和视频/语音/文件卡片挂载到对应聊天记录（`$BATCH/attachments/...`）、生成本地预览（`$BATCH/preview`）和导览输入（`$BATCH/bot-input.json`）。
   主 agent 读 `$BATCH/bot-input.json` 和 `$BOT/prompts/daily-bot.md`，直接写出 `$REPORTS/$D-AgentHub导览草稿.md`，并用 `node "$BOT/scripts/check-bot.mjs" "$BATCH/bot-input.json" "$REPORTS/$D-AgentHub导览草稿.md" --fix` 校准版式和字数。

4. **发布（获准后，1 条命令）**
   ```sh
   node "$BOT/scripts/daily.mjs" publish "$D" --batch "$BATCH" --external "$EXTERNAL"
   ```
   自动执行入库（含附件与头像）、增量链接预览抓取、单次公开构建、可选语义向量与 D1 `stories` ID 登记（供 `discussion_opens` 讨论打开统计）、提交推送、等待 GitHub Actions 部署完成，并将导览标题改为“日报已上线”（前端已移除点赞/点踩，保留 `views.js` 流量统计、`discussion_opens`、搜索与 Agent 读取统计）。

## 媒体、链接预览与性能红线（硬规范）

- **仅挂载入选讨论的媒体**：`package-daily.mjs` / `weekly-attach-discussions.mjs` 只复制进入讨论记录的文件；单文件硬上限 **10 MB**（超限自动降级为元信息卡片，`test/build.mjs` 强制校验）。
- **自动压缩与零 CLS**：`collect-images.mjs` 解码后自动将图片转为 WebP（最长边 ≤ 1440px）并写入 `width`/`height`，将视频重编码为 H.264（最大宽 960px + `+faststart`）。
- **链接预览增量缓存**：`daily.mjs finish` 与 `publish` 自动调用 `fetch-link-previews.mjs --batch "$BATCH"` 增量更新 `newspaper/data/link-previews.json`（构建期输出 `link-previews.js`，兼容严格 CSP 与 `file://`）。
- **前端性能预算**：禁用中文字体分片（仅保留 `Inter Variable` + 系统原生中文字体）；日报原始讨论拆分为按需懒加载 `issues/<date>.discussions.js`；CSS/JS 按页面合并压缩，`discussion-panel.js` / `share-image.js` / `ranking.js` / `link-previews.js` 均按需懒加载；不再引入点赞/点踩等首屏外部 API 请求。

## 资料库、机会与黑话

资料库、机会和黑话默认每周随周报增量更新一次（见[周报流程](references/weekly.md)）。
