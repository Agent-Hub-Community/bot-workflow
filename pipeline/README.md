# AgentHub 采集流水线（pipeline）

这里的脚本读微信本地数据和私有工作数据，产出 AgentHub 日报需要的私有输入：群聊原文、图片描述、活跃榜快照，以及资料库、机会、术语的候选清单。本仓库的写稿脚本（`scripts/`）和网站仓库 `newspaper` 只用这些产出写稿和发布刊期，不读微信。

所有产出都写在 `newspaper` 仓库的 `scratch/` 下，或写进命令行指定的批次目录。`scratch/` 被 `newspaper` 的 `.gitignore` 忽略。产出含群聊原文和成员信息，默认留在本机，脚本不自动上传。另获明确授权后，可把指定的去凭据副本归档到指定私有仓库；凭据、微信数据库和解密缓存不进任何仓库。

## 目录布局

流水线所在的仓库与 `newspaper` 仓库并排放置：

```text
<workspace>/
├── newspaper/              网站仓库：lib/ 公开模块、data/ 刊期和榜单快照、scratch/（忽略）
├── bot-workflow/
│   ├── lib/                newspaper-root.mjs、llm.mjs
│   ├── pipeline/           本目录
│   ├── prompts/            模型 prompt（读图用 image-description.md）
│   └── scripts/            写稿脚本
└── reports/                早期周报导出（可选，chat-days.mjs 读取）
```

`../lib/newspaper-root.mjs` 负责找到网站仓库，`pipeline/` 和 `scripts/` 共用它：

- 设置了 `NEWSPAPER_DIR` 时，用它指向的目录。相对路径按当前目录解析。
- 未设置时，用本仓库旁边的 `newspaper/`。

网站仓库缺少 `package.json` 或 `lib/groups.mjs` 时，脚本立即报错，并提示设置 `NEWSPAPER_DIR`。脚本只通过 `load('lib/xxx.mjs')` 动态导入网站模块，读快照和刊期（`data/` 下）也基于这个根目录。prompt 和模型配置在本仓库的 `prompts/`、`lib/llm.mjs`。

## 安装

1. 准备 Node.js 22.15 或更新版本，推荐 Node.js 24。采集链使用 `node:sqlite` 和 `zstdDecompressSync`，后者从 Node.js 22.15 才提供。
2. 按[采集说明](../docs/collection.md)自行安装并初始化 wx CLI，再安装 `ffmpeg`。`ffmpeg` 用来把 wxgf 和 GIF 图片转成 JPEG。
3. 在 `newspaper` 仓库里运行 `npm ci`。

本仓库没有自己的 npm 依赖，也不需要 `node_modules`。网站模块里的第三方包按 Node 的解析规则从 `newspaper/node_modules` 加载；本仓库脚本直接用到的 `linkedom` 经 `newspaper-root.mjs` 的 `requirePackage` 从同一目录加载。

4. 在 `pipeline/` 目录复制私有配置模板，再填入真实值：

```sh
cp groups.example.mjs groups.private.mjs
```

## 私有配置

`groups.private.mjs` 不提交，`.gitignore` 已经排除它。它的形状与 `groups.example.mjs` 相同，导出两个值：

| 导出 | 含义 | 获取方法 |
| --- | --- | --- |
| `chatrooms` | 群 id（`group-1` 等，与 `newspaper/lib/groups.mjs` 一致）到微信群 username（`<数字>@chatroom`）的映射 | `wx sessions --json` 列出会话及 username |
| `libraryOperators` | 发日报、往各群转发外链的运营账号的成员哈希 | 取该账号微信 username 的 SHA-256 前 12 位十六进制（`newspaper/lib/activity.mjs` 的 `memberKey`）；没有运营账号就留空数组 |

`chat-groups.mjs` 读取这个文件，把公开的分组字段（id、label、from、page、pageFrom）与 `username` 合并，得到与旧版 `groups.mjs` 相同形状的分组列表。以下情况脚本会报错：

- 文件不存在：报错并提示复制模板。
- 某个群的 username 仍是占位符：报错。
- 网站新增的群在 `chatrooms` 里没有 username：报错。

`libraryOperators` 的传递路径：`collect-library-candidates.mjs` 把它写进 `candidates.json` 的 `operators` 字段，公开的 `newspaper/scripts/assemble-library.mjs` 从这个字段读取，不读本目录的任何文件。`candidates.json` 没有该字段时，`assemble-library.mjs` 不排除任何账号，并输出警告。

## 环境变量

| 变量 | 用于 | 说明 |
| --- | --- | --- |
| `NEWSPAPER_DIR` | 全部脚本 | 网站仓库路径。目录布局与上图一致时可不设 |
| `WX_ACTIVITY_HOME` | 读微信数据的脚本 | 已核验的 AgentHub 账号 HOME，其中有 `.wx-cli/config.json` 和 `.wx-cli/cache/_mtimes.json` |
| `WX_BIN` | `collect-daily.mjs` | wx CLI 路径，默认用 `PATH` 里的 `wx` |
| `DAILY_OUTPUT_DIR` | `collect-daily.mjs` | 单日输出目录。`collect-batch.mjs` 会自动设置 |
| `DAILY_GROUP` | `collect-daily.mjs` | 只采集一个群，如 `group-2` |
| `DAILY_LLM_API_KEY`、`DAILY_LLM_BASE_URL` | `collect-images.mjs` | 图片描述模型的密钥和端点，由本仓库的 `lib/llm.mjs` 读取 |

## 日报流程中的命令

以下命令在网站仓库目录下执行，`$BOT` 指本仓库根目录，`$PIPELINE` 指本目录（`$BOT/pipeline`）。`D` 是刊期日期，`B` 是批次目录（如 `scratch/day-YYYY-MM-DD-run1`），`WX_HOME` 是刚核验过的账号 HOME。

```sh
cd "$NEWSPAPER"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" "$D" "$D" "$B"
WX_ACTIVITY_HOME="$WX_HOME" DAILY_LLM_API_KEY=... node "$PIPELINE/collect-images.mjs" "$D" "$B"
node "$BOT/scripts/prepare-week-d.mjs" generate "$D" "$D" "$B" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package "$D" "$D" "$B" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$B"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/prepare-release-activity.mjs" "$B"
```

- `collect-batch.mjs` 取代了原来的 `prepare-week-d.mjs collect`，参数不变。`scripts/prepare-week-d.mjs` 只保留 `generate` 和 `package`。
- 重跑 `collect-batch.mjs` 会覆盖群聊输入，之后要再跑 `collect-images.mjs`。
- 同一账号的数据库读取串行执行。

## 脚本

| 脚本 | 用途 | 读取 | 写入 |
| --- | --- | --- | --- |
| `collect-batch.mjs FROM THROUGH B` | 按日期逐日调用 `collect-daily.mjs` | 同 `collect-daily.mjs` | `B/<日期>/` |
| `collect-daily.mjs DATE` | 用 wx CLI 导出一天各群消息，生成群稿输入 | wx CLI | `group-N.raw.json`、`group-N.input.json` |
| `collect-images.mjs DATE B` | 解密群聊图片，请模型写客观描述 | 微信附件目录、缓存库 | `B/DATE/media/`、`group-N.images.json`；描述缓存在网站仓库的 `scratch/image-descriptions/` |
| `prepare-release-activity.mjs B` | 发布级活跃榜：各群日榜、社区周/月/总榜和头像 | 缓存库、网站仓库的 `data/public-activity/` | `B/activity/` |
| `collect-library-candidates.mjs` | 列出群里分享的链接，供资料库审核 | 私有批次、周报导出、网站仓库的 `data/editions/` 和 `data/library.json`；设了 `WX_ACTIVITY_HOME` 时还读缓存库 | `scratch/library/candidates.json` |
| `collect-opportunity-candidates.mjs` | 列出招聘、活动、征稿候选 | 私有批次、周报导出、资料库候选及其审核批次 | `scratch/opportunities/candidates.json` |
| `collect-glossary-chunks.mjs` | 按块导出去掉链接和提及的群聊文本，供术语审核 | 私有批次、周报导出 | `scratch/glossary/` |
| `chat-days.mjs` | 被候选收集脚本共用：按天读取私有群聊记录 | 网站仓库 `scratch/` 与上级 `reports/` | 无 |
| `wechat-images.mjs` | 被 `collect-images.mjs` 使用：定位并解密微信 `.dat` 图片 | 附件目录 | 无 |
| `chat-groups.mjs` | 合并私有分组 | `groups.private.mjs`、网站仓库的 `lib/groups.mjs` | 无 |

运行时读取的“私有批次”指网站仓库 `scratch/` 下的 `group-N.input.json`。资料库、机会和术语候选的审核规范，见网站仓库的 `docs/review/library.md`、`docs/review/opportunities.md`、`docs/review/glossary.md`。

## 测试

在本仓库根目录运行：

```sh
NEWSPAPER_DIR=/path/to/newspaper npm test
```

`npm test` 同时运行 `scripts/` 和 `skill/scripts/` 的测试；只跑本目录时用 `node --test pipeline/test/*.test.mjs`。测试使用 `groups.example.mjs` 的占位 username 和临时目录里的合成数据，不读真实微信数据。只有 `groups.private.mjs` 存在时，才会额外检查它是否覆盖网站的每个群；文件不存在时跳过这一项。
