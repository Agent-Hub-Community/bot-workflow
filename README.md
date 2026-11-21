# bot-workflow

[Agent Hub 社区日报](https://agent-hub-community.github.io/newspaper/)的本地采集、媒体挂载与 Antigravity（Gemini）日报/周报编排工具。

整套流程完全由 **Antigravity（Gemini）及其并行 subagent** 驱动：
- **零外部 LLM API**：不再依赖 `gemini-4-argon`、`gpt-6-luna`、`magpie`、`coproxy` 或任何 `DAILY_LLM_*` 配置；
- **零二轮审稿阻塞**：每个群由独立 subagent（T3 Code 优先 `delegate_task`）直读消息与关键图片，一步产出含 `tldr`、`points`（精确消息溯源 `refs`）、正文、`emphasis` 与 `Bot 锐评` 的定稿；
- **聊天记录原生静态媒体**：已解码图片自动转 WebP 挂载进讨论面板，视频/语音/文件自动展示卡片并增量缓存链接预览；
- **极简入库与合并发布**：`publish` 默认 `--skip-build` 0 秒纯数据入库（无需本地 `FEEDBACK_API_URL` 也不重复编 `dist/`），多日补发支持 `--no-push` 合并为单次推送由 GitHub Actions 统一测试、构建并部署。

## 日报 4 步流程

```text
1. daily.mjs collect D        本地串行：微信采集（最新期默认 --through-now 截到生成时刻）-> 纯本地解图 -> 活跃榜；并行：外部资讯候选
        |
2. Antigravity 并行 subagent  每群 1 个 subagent（直接 read_file 看关键图）直出含 tldr/points/refs/Bot 锐评的 draft.json；
        |                     外部资讯 subagent 同步核实一手来源并直出 reviewed-final.json
        v
3. daily.mjs finish D         打包 issues.json + 自动挂载媒体附件 + 增量链接预览 + 本地预览 + bot-input.json
        |                     主 agent 直出导览草稿并用 check-bot.mjs 校准排版
        v
4. daily.mjs publish D        获准后 0 秒纯数据入库（--skip-build）-> commit -> push -> GitHub Actions 测试构建部署（--verify 可选回读核验）
                              多日补发前几期加 --no-push，最后一期统一 push 一次部署
```

## 安装与环境

推荐 Node.js 24（最低 22.15），复用了旁边 `../newspaper` 的 `node_modules`。

1. 把 `newspaper` 和 `bot-workflow` 放在同一父目录，并在 `newspaper` 运行 `npm ci`。
2. 配置 `pipeline/groups.private.mjs`（微信群 `<数字>@chatroom`）和本地环境变量（见 `config/env.example`）。
3. 把 `skill/` 软链给 Antigravity：
   ```sh
   ln -sfn "$BOT/skill" "$HOME/.gemini/config/skills/agenthub-daily"
   ```
4. 在工作区直接对 Antigravity 说“跑一下昨日日报”或“生成并发布昨日日报”。详细命令见 [`skill/SKILL.md`](skill/SKILL.md) 和 [`skill/references/runbook.md`](skill/references/runbook.md)。

## 目录结构

| 目录 | 说明 |
|---|---|
| `pipeline/` | 微信消息导出、纯本地 `.dat` 解图、活跃榜、周报/资料库/机会/黑话采集 |
| `scripts/` | `daily.mjs`、`package-daily.mjs`、`check-bot.mjs`、`collect-external.mjs`、周报组装脚本 |
| `prompts/` | Antigravity subagent 使用的日报、周报、外部资讯与导览指令 |
| `lib/` | 讨论节选、静态媒体路径、导览校验、跨日讨论身份 |
| `skill/` | Antigravity 原生 skill 与操作手册 |
| `config/` | 环境变量模板（仅微信与发布配置，无 LLM API） |

## 测试

```sh
NEWSPAPER_DIR=/path/to/newspaper npm test
```
