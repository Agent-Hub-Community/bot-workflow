# 离线合成示例

这个目录放了一套纯虚构的两天五群聊天、外部资讯候选、固定模型返回和自绘方块头像，用来在不接微信、不配 API Key 的情况下，把写稿、周报讨论串联、定稿校验和网页预览整条命令链跑通一遍。

## 怎么跑

前提：Node.js 22.15 以上、Git，以及一份已经跑过 `npm ci` 的干净 `newspaper` 克隆。

注意：`newspaper` 的 `prepare-preview.mjs` 会重写它自己目录里的 `dist-preview/`。如果你手头正在用某个 `newspaper` 克隆审真日报，别拿同一个克隆跑示例，免得把正在看的预览冲掉。

1. 在 `newspaper` 克隆装好依赖：

   ```bash
   npm --prefix /path/to/newspaper ci
   ```

2. 在 `bot-workflow` 根目录跑示例脚本：

   ```bash
   node scripts/run-synthetic-example.mjs --out /tmp/bot-workflow-example
   ```

   如果 `newspaper` 不在同级的 `../newspaper`，加上 `NEWSPAPER_DIR`：

   ```bash
   NEWSPAPER_DIR=/path/to/newspaper \
     node scripts/run-synthetic-example.mjs --out /tmp/bot-workflow-example
   ```

3. 看终端打印出来的 `runDirectory` 和 `previewDirectory`。每次运行会在 `--out` 下面新建一个 `run-*` 子目录，不会删掉上次的结果；`run-*/result.json` 里记着跑过的每一步和校验结果。

4. 用静态服务器打开 `previewDirectory`（只服务这个 `preview/` 子目录）：

   - `/newspaper/daily/2026-10-20/group-1/`：看合成的日报正文、重点、AI 锐评、指向 `example.org` 的资料卡片和讨论气泡。
   - `/newspaper/daily/2026-10-21/group-1/`：看跨日引用筛选后保留原有“群友 3／群友 4”编号的讨论节选。
   - `/newspaper/daily/2026-10-21/external/`：看合成的外部资讯版。

   注：预览站里除了这两天的合成内容，还会带上 `newspaper` 仓库里本来就有的往期公开页面。

## 里面跑了哪些步骤

| 步骤 | 用到的脚本 | 验证什么 |
|---|---|---|
| 日报生成与打包 | `prepare-week-d.mjs generate` / `package` | 两天五群输入（五群为空，一到四群各一条话题）能正常打包 |
| 锐评、报头与重点 | `enrich-month-d.mjs` | 版头、AI 锐评与重点片段合并无误 |
| 周报跨日身份与讨论节选 | `generate-weekly-gemini.mjs`、`weekly-discussion-evidence.mjs`、`weekly-attach-discussions.mjs`、`weekly-select-discussion.mjs` | 同一位虚构群友第一天是 `p1`、第二天变成 `p2` 时不会串人；筛掉中间消息后，剩余发言仍保持原来的“群友 N”编号 |
| 定稿与回执 | `finalize-batch.mjs`（`candidate` → `review --approve` → `finalize`） | `topic_key` 与 `feedbackId` 精确配对，签发回执并产出 `final/issues.json` |
| 外部资讯 | `generate-external.mjs`、`generate-external-comments.mjs`、`review-external.mjs` | 外部候选生成、补锐评并写出审核记录 |
| 静态预览 | `newspaper/scripts/prepare-preview.mjs` | 调用真构建器生成预览，并核对页面数据与定稿一致 |

脚本在本地 `127.0.0.1` 随机端口起一个微型 HTTP 服务，固定返回 `fixtures.mjs` 里写好的 JSON（模型名标为 `synthetic-fixed-response`），跑完即关；子进程也不继承宿主环境里的真实模型密钥、微信路径或代理设置。
