# 操作手册（Antigravity 原生版）

先加载环境变量：

```sh
source /Users/haoqing/Documents/Github/summary_bot/config/daily-env.sh
cd "$NEWSPAPER"
```

所有写稿、读图、外部资讯和导览均由 Antigravity（Gemini）及其并行子任务完成，不再配置任何 `DAILY_LLM_*` 或外部代理。

- **T3 Code 环境优先使用 `delegate_task`**（先调一次 `orchestrator_capabilities`，再以 `mode: "async"`、`target: { providerInstanceId: "antigravity", model: "gemini-4-neon", options: { thought_level: "low" } }` 并行派发；大群多图时提示分批读图、每次 6–8 张，避免单步思考过长触发上游超时）。这样即使对话开在其他仓库工作区，子任务也能继承 `full-access` 权限直接读写 `$NEWSPAPER/scratch` 与 `$BOT`，不会像原生 `invoke_subagent` 那样因跨工作区权限拦截无法透传到 UI 而卡死。
- **非 T3 环境且工作区在 `summary_bot` 时**，使用原生 `invoke_subagent`（`TypeName: "self"`）。

## 1. 采集（1 条命令）

```sh
node "$BOT/scripts/daily.mjs" collect "$D"
```

编排如下（日志在 `$BATCH/logs/`）：

| 顺序 | 步骤 | 说明 |
|---|---|---|
| 1 | `collect-batch` | 导出北京时间整日消息（`raw.json`、`input.json`） |
| 2 | `collect-images` | 纯本地解码 `.dat` / 提取视频与 ≤10 MB 文件，自动转 WebP（写宽高）与 faststart MP4 到 `$BATCH/$D/media/<group>/` |
| 3 | `release-activity` | 计算日榜与周/月/总榜，自动剔除占位头像 |
| 并行 | `collect-external` | 抓 AIHOT / HF / alphaXiv / HN / X 基础候选 |

- 读微信库的三步自动串行；`collect-external` 失败只告警不停主线。
- **采集窗口规则**：当 `$D` 是北京时间昨天（最新一期）时，默认自动启用 `--through-now`，微信聊天与外部资讯均覆盖 **`$D` 00:00 起至生成时刻**（昨天完整一天 + 今天 00:00 到生成当下）；补跑更早日期时默认严格按 `$D` 00:00–24:00（可加 `--through-now` 或 `--strict-day` 显式覆盖）。次日新刊写稿时若前一期已带出当日凌晨旧闻，自然跳过不重复报道。
- 某步失败时用 `--batch "$BATCH" --from-step <step>` 续跑。
- 跑完会打印各群条数与已解图张数。某群 0 条时，可快速确认是当天没人说话还是微信客户端未同步。

## 2. 并行派发子任务出稿

在 T3 Code 环境下先调用一次 `orchestrator_capabilities`，然后在一个 turn 里并行调用 `delegate_task`（`mode: "async"`、`target: { providerInstanceId: "antigravity", model: "gemini-4-neon" }`；非 T3 环境且在 `summary_bot` 工作区时改用 `invoke_subagent` `TypeName: "self"`）：

### 群稿子任务（活跃群各 1 个；消息极少的群/专项群可合并为 1 个）

给每个群子任务的任务清单：
- 读 `$BOT/prompts/daily-group.md`（写作规则 + JSON Schema）与 `$BOT/prompts/daily-comment.md`
- 读 `$BATCH/$D/<group>.input.json`（必要时对照 `<group>.raw.json`）
- 对消息里存在 `image.file` 的图片，直接 `read_file` 打开 `$BATCH/$D/<image.file>` 看图
- 一次性写入 `$BATCH/$D/<group>.draft.json`（含 `heading`、`theme`、`stories`（每条含 `category`、`title`、`text`、`emphasis`、`aiComment`、`evidence_ids`、`discussion_range`、`resources`）和可选 `image_alts`）
- 垂类专项群（`group-6` AI Safety、`group-7` Robot、`group-8` AI4S）若当天无实质讨论，写 `{"heading":"","theme":"","stories":[]}` 即可，打包时会自动省略空版
- 写完用 `node` 校验 JSON 合法且必填字段齐全；提示子任务不要再启动子 agent

### 外部资讯子任务（与群稿同时并行）

- 读 `$EXTERNAL/discovery.json`、`$BOT/skill/references/external-sources.md`、`$BOT/prompts/external-editor.md` 和 `$BOT/prompts/daily-comment.md`
- 按“先扫、再挑、只核实入选的”补查重点来源并核实入选条目的一手原文（严格对齐目标日期的北京时间 24 小时窗口，补跑多天时避免跨日重复）
- 写出 `$EXTERNAL/selection.json` 和 `$EXTERNAL/reviewed-final.json`（每条包含 `emphasis` 和 `aiComment`，`links[].url` 逐字来自 `selection.json`）
- 写完用 `node` 校验 JSON 合法与链接一致性

## 3. 打包、自动挂载媒体与本地预览

```sh
node "$BOT/scripts/daily.mjs" finish "$D" --batch "$BATCH" --external "$EXTERNAL"
```

这条命令依次执行：
1. `package-daily.mjs`：把各群 `draft.json` 打包为 `$BATCH/issues.json`，自动裁剪不合规范的 `emphasis`，按 `discussion_range`（或 `evidence_ids` 首尾）截出匿名讨论记录，仅把**入选讨论**里的图片（含宽高）/视频/≤10 MB 文件按内容 MD5 去重复制到 `$BATCH/attachments/`，最后写出 `$BATCH/bot-input.json`。
2. `fetch-link-previews.mjs --batch "$BATCH"`：增量抓取本期讨论新增裸链的 OpenGraph/oEmbed 预览到 `newspaper/data/link-previews.json`（网络失败只告警不阻断）。
3. `newspaper/scripts/prepare-preview.mjs`：带着 `--attachment-dir "$BATCH"` 构建本地预览到 `$BATCH/preview/`。

## 4. 写发群导览草稿

主 agent 读 `$BATCH/bot-input.json` 和 `$BOT/prompts/daily-bot.md`，直接写出 `$REPORTS/$D-AgentHub导览草稿.md`，再跑一次格式与字数校准：

```sh
node "$BOT/scripts/check-bot.mjs" "$BATCH/bot-input.json" "$REPORTS/$D-AgentHub导览草稿.md" --fix
```

只做本地预览时到这里即可交付（附预览路径与导览草稿路径）。

## 5. 发布上线（获准后）

```sh
# 单日发布
node "$BOT/scripts/daily.mjs" publish "$D" --batch "$BATCH" --external "$EXTERNAL" --verify

# 多日补发：前几期只做本地入库+commit（0 秒），最后一期统一 push + deploy + verify
node "$BOT/scripts/daily.mjs" publish "$D1" --batch "$BATCH1" --external "$EXTERNAL1" --no-push
node "$BOT/scripts/daily.mjs" publish "$D2" --batch "$BATCH2" --external "$EXTERNAL2" --verify
```

依次执行：`newspaper/scripts/release.mjs --skip-build`（纯数据入库：日报 + 附件 + 头像 + 外部资讯，不要求本地 `FEEDBACK_API_URL` 也不重复编 `dist/`）→ 增量 `fetch-link-previews.mjs` → `git commit` → `git push origin main` → `gh run watch` 等待 GitHub Actions 跑完 `npm test`、公开构建与 Pages 部署 → 把导览草稿首行改成 `日报已上线`。

- 如需本地运行完整公开构建与 D1 登记，可显式追加 `--local-build`。
- 如需要额外线上回读核验，加 `--verify` 触发 `verify-publication.mjs`。

### 修旧刊期

直接编辑 `$NEWSPAPER/data/editions/<date>.json` 或重新导入外部资讯，不动 `data/public-activity/`。
