# 采集脚本（pipeline）

这个目录里的脚本负责跟本机微信数据打交道：导出每天的群聊消息、解出聊天图片并请模型写图说、计算活跃榜快照，以及在每周出周报时捞出资料库、机会和黑话的候选。后面的写稿脚本（`scripts/`）和网站仓库 `newspaper` 都只读这里产出的 JSON，自己不碰微信。

产出默认写在 `newspaper/scratch/` 或你传进来的批次目录里。因为里面带着原始聊天和成员信息，这些目录都被 `.gitignore` 忽略，平时只留本机。

## 目录怎么摆

默认把 `bot-workflow` 和 `newspaper` 放在同一个父目录下：

```text
<workspace>/
├── newspaper/              网站仓库：lib/ 公共模块、data/ 公开数据、scratch/（忽略）
├── bot-workflow/
│   ├── lib/                newspaper-root.mjs、llm.mjs 等
│   ├── pipeline/           本目录
│   ├── prompts/            模型 prompt（读图用 image-description.md）
│   └── scripts/            写稿与审核脚本
└── reports/                早期周报文本导出（可选，chat-days.mjs 会顺带读）
```

`../lib/newspaper-root.mjs` 负责定位 `newspaper` 仓库：设了环境变量 `NEWSPAPER_DIR` 就用它，没设就找旁边的 `../newspaper`。如果目录里没有 `package.json` 或 `lib/groups.mjs`，脚本会直接报错提示。

## 准备环境

1. 装 Node.js 22.15 以上（推荐 24）。采集用到了内置的 `node:sqlite` 和 Node 22.15 才有的 `zstdDecompressSync`。
2. 按[采集说明](../docs/collection.md)装好并初始化 wx CLI，顺手装上 `ffmpeg`（转微信的 wxgf 和动图用）。
3. 在 `newspaper` 仓库跑一次 `npm ci`。本仓库不装自己的 `node_modules`，需要的第三方包（比如 `linkedom`）通过 `newspaper-root.mjs` 从 `newspaper/node_modules` 加载。
4. 复制群配置模板，填进真群号：

   ```sh
   cp pipeline/groups.example.mjs pipeline/groups.private.mjs
   ```

## `groups.private.mjs` 怎么填

这个文件被 `.gitignore` 排除，只放两个导出值：

| 导出名 | 填什么 | 怎么拿 |
|---|---|---|
| `chatrooms` | 群 id（`group-1` 到 `group-5`，跟 `newspaper/lib/groups.mjs` 对齐）到微信群号 `<数字>@chatroom` 的映射 | 跑 `HOME="$WX_HOME" wx sessions --json` 查看 |
| `libraryOperators` | 负责往各群发日报、转外链的运营账号哈希数组 | 对运营号微信 `username` 算 SHA-256 取前 12 位十六进制（`newspaper/lib/activity.mjs` 的 `memberKey`）；没有就填 `[]` |

`chat-groups.mjs` 会把 `newspaper/lib/groups.mjs` 里的公开配置（id、名称、何时开始采集、何时出读者版面）和这里的 `chatrooms` 拼在一起。缺文件、留着占位符没改、或者网站新加了群这里没配，脚本都会报错拦住。

## 环境变量

| 变量 | 谁在用 | 说明 |
|---|---|---|
| `NEWSPAPER_DIR` | 全部脚本 | `newspaper` 仓库路径；两个仓库并排摆时不用设 |
| `WX_ACTIVITY_HOME` | 读微信的脚本 | 已初始化好的微信账号 HOME（底下有 `.wx-cli/config.json` 和 `.wx-cli/cache/`） |
| `WX_BIN` | `collect-daily.mjs` | `wx` 可执行文件路径，默认直接找 `PATH` |
| `DAILY_OUTPUT_DIR` | `collect-daily.mjs` | 单日导出目录；用 `collect-batch.mjs` 时会自动设好 |
| `DAILY_GROUP` | `collect-daily.mjs` | 只导某一个群（如 `group-2`）时用 |
| `DAILY_LLM_BASE_URL`、`DAILY_LLM_API_KEY`、`DAILY_LLM_MODEL` | `collect-images.mjs` | 读图调用的视觉模型接口、密钥和模型名（由 `lib/llm.mjs` 读取） |

## 常用命令

一般站在 `$NEWSPAPER` 目录下跑（`$BOT` 指本仓库根目录，`$PIPELINE` 指 `$BOT/pipeline`）：

```sh
cd "$NEWSPAPER"
D=2026-10-25
B=scratch/day-$D-run1

WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" "$D" "$D" "$B"
WX_ACTIVITY_HOME="$WX_HOME" DAILY_LLM_API_KEY=... node "$PIPELINE/collect-images.mjs" "$D" "$B"
```

注意：重跑 `collect-batch.mjs` 会重写 `group-N.input.json`，之前写进去的图片描述会被冲掉，要再跑一次 `collect-images.mjs`（已有缓存的图会直接命中 `scratch/image-descriptions/`，不会重新调模型）。

## 脚本一览

| 脚本 | 干什么 | 读哪里 | 写哪里 |
|---|---|---|---|
| `collect-batch.mjs FROM THROUGH B` | 按天循环调 `collect-daily.mjs` | 同下 | `B/<日期>/` |
| `collect-daily.mjs DATE` | 调 `wx` 导出各群一天消息，生成原始记录和脱敏输入 | wx CLI | `group-N.raw.json`、`group-N.input.json` |
| `collect-images.mjs DATE B` | 解密聊天里的 `.dat` 图片，调模型生成客观图说 | 微信附件目录、缓存库 | `B/DATE/media/`、`group-N.images.json` 及 `scratch/image-descriptions/` |
| `prepare-release-activity.mjs B` | 算各群日榜与社区周／月／总榜，导出前三名头像供审核 | 缓存库、`newspaper/data/public-activity/` | `B/activity/` |
| `collect-library-candidates.mjs` | 收集群里分享过的外部链接，供资料库审核 | 私有批次、`reports/`、`newspaper/data/`（设了 `WX_ACTIVITY_HOME` 时加读缓存库） | `scratch/library/candidates.json` |
| `collect-opportunity-candidates.mjs` | 收集招聘、活动、征稿候选 | 私有批次、`reports/`、资料库候选与审核结果 | `scratch/opportunities/candidates.json` |
| `collect-glossary-chunks.mjs` | 把群聊按块切成纯文本，供黑话词典审读 | 私有批次、`reports/` | `scratch/glossary/` |
| `chat-days.mjs` | 内部模块：按天汇总本地已有的群聊记录 | `scratch/`、`reports/` | 无 |
| `wechat-images.mjs` | 内部模块：定位并解开微信 `.dat` 加密图片 | 微信附件目录 | 无 |
| `chat-groups.mjs` | 内部模块：合并公开群定义与私有群号 | `groups.private.mjs`、`newspaper/lib/groups.mjs` | 无 |

## 测试

在仓库根目录跑 `NEWSPAPER_DIR=/path/to/newspaper npm test`，或者只跑本目录：`node --test pipeline/test/*.test.mjs`。测试用 `groups.example.mjs` 的假群号和临时目录造数据，不碰真微信；只有本机配了 `groups.private.mjs` 时，才会多跑一条检查看它有没有漏配群。
