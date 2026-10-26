# bot-workflow

[Agent Hub 社区日报](https://agent-hub-community.github.io/newspaper/)的采集与写稿流程。它读取本机已同步的群聊，采集外部资讯，让模型写初稿，再由主编（人或 agent）核对原文、审核隐私和验收网页。

本仓库与 [newspaper](https://github.com/Agent-Hub-Community/newspaper) 配合使用。bot-workflow 负责采集、模型调用和编辑流程；newspaper 提供内容 schema、校验、网页构建和发布。真实刊期需要 agent 参与选题、补查与审核，没有一条命令能自动完成这些判断并发布。

| 想做什么 | 从哪里开始 |
|---|---|
| 不接微信或模型，先跑一份示例 | [安装](#安装)与[合成示例](#合成示例) |
| 理解原始消息、图片和榜单怎么来 | [采集说明](docs/collection.md) |
| 生成真实日报或周报 | [agent skill](skill/SKILL.md)与[操作手册](skill/references/runbook.md) |
| 查脚本的输入、输出和参数 | [写稿脚本](scripts/README.md)、[采集脚本](pipeline/README.md) |
| 审核并定稿一份日报批次 | [定稿接口](docs/finalize.md) |
| 查看早期脚本和 prompt 实验 | [legacy](legacy/README.md) |

## 安装

推荐 Node.js 24，最低为 Node.js 22.15。采集链使用 `node:sqlite` 和 [`zstdDecompressSync`](https://nodejs.org/docs/latest-v22.x/api/zlib.html#zlibzstddecompresssyncbuffer-options)，后者从 Node.js 22.15 才提供。bot-workflow 没有 npm 包依赖，第三方包从 newspaper 的 `node_modules` 加载。

1. 把两个仓库克隆到同一个父目录。

   ```sh
   git clone https://github.com/Agent-Hub-Community/newspaper.git
   git clone https://github.com/Agent-Hub-Community/bot-workflow.git
   ```

   ```text
   work/
   ├── newspaper/       内容 schema、网页和发布
   └── bot-workflow/    采集、写稿和审核流程
   ```

2. 在 newspaper 仓库安装依赖。

   ```sh
   cd newspaper
   npm ci
   cd ../bot-workflow
   ```

3. 指定两个仓库的位置。

   ```sh
   export BOT="$PWD"
   export NEWSPAPER_DIR="$(cd ../newspaper && pwd)"
   export NEWSPAPER="$NEWSPAPER_DIR"
   export PIPELINE="$BOT/pipeline"
   ```

`NEWSPAPER_DIR` 可指向其他目录。未设置时，脚本通过 `lib/newspaper-root.mjs` 寻找本仓库旁边的 `../newspaper`。缺少 newspaper 的模块时会报错，不会下载或创建替代仓库。生产命令通常在 `$NEWSPAPER` 下执行，相对路径参数按当前工作目录解析。

### 合成示例

示例使用 `examples/synthetic/` 中的合成消息和预设模型响应，演示输入、初稿、审核候选、审核回执、定稿和网页预览之间的关系。不需要微信账号、API 密钥或 Cloudflare 账号，也不调用真实模型。

使用专用、干净的 newspaper 克隆运行示例。预览构建会写该克隆的 `dist-preview/`，不能与真实刊期的预览构建同时运行；不会写正式的 `data/` 或发布网站。输出应放在 newspaper 克隆之外，使用新目录或示例脚本自己标记的目录，每次运行都会新建一个 `run-*` 子目录。

```sh
node scripts/run-synthetic-example.mjs --out "$BOT/../synthetic-example"
```

脚本输出本次的 `runDirectory`、`finalDirectory` 和 `previewDirectory`，并在运行目录保存 `result.json`。查看 `final/issues.json` 与 `final/receipt.json` 时，可对照[定稿接口](docs/finalize.md)。示例证明的是离线组装和校验链路可以运行，不证明模型摘要质量；newspaper 克隆中原有的公开历史页面也不属于合成数据。

## 配置真实采集与写稿

警告：模型端点会收到群聊正文和图片。运行者应先确认群内用途约定、数据范围及端点的数据政策，再发送材料。化名和自动去敏不能保证正文完全匿名。

1. 按[采集说明](docs/collection.md)自行安装并初始化 [wx CLI](https://github.com/jackwener/wx-cli)。本仓库不自动执行 `sudo`、重新签名、退出或重启微信。初始化可能涉及读取进程内存，应由运行者确认目标账号并执行。
2. 用目标账号的独立 HOME 核验群列表与近期消息。只验证会话列表不够，还要核对实际消息日期。

   ```sh
   export WX_HOME=/path/to/your/initialized/wx-account-home
   HOME="$WX_HOME" wx sessions --json -n 20
   HOME="$WX_HOME" wx history '<数字>@chatroom' --json -n 20
   ```

3. 复制群配置模板并填入自己的 chatroom username。

   ```sh
   cp pipeline/groups.example.mjs pipeline/groups.private.mjs
   ```

   群的公开名称、采集起始日期和版面起始日期由 newspaper 的 `lib/groups.mjs` 定义。私有配置只保存账号关联。

4. 复制环境模板，填写路径和模型端点，再加载环境变量。密钥可在运行时从自己的密钥存储导出，不写入会提交的文件。

   ```sh
   cp config/env.example .env.local
   # 编辑 .env.local 后加载
   set -a; . ./.env.local; set +a
   ```

5. 如需浏览器验收，在 newspaper 仓库安装 Chromium。

   ```sh
   cd "$NEWSPAPER"
   npx playwright install chromium
   ```

6. 按所用 agent 的方式安装本仓库的 `skill/`。例如，目标目录不存在时，Claude Code 可使用符号链接。

   ```sh
   ln -s "$BOT/skill" "$HOME/.claude/skills/agenthub-daily"
   ```

7. 对 agent 说“生成昨日完整日报”。默认完成本地预览和导览草稿，不发布，不发群。发布本期需要明确授权，以及 newspaper 仓库和站点对应的权限。

`groups.private.mjs`、`.env.local` 和 `scratch/` 被 Git 忽略。忽略规则不能代替提交前的内容检查。读图还需要 `ffmpeg`；外部来源可选用 opencli；站点的反馈与语义检索服务需要发布者自行配置。

## 当前生产流程

下图标出材料经过的位置与发布边界。

```text
[本机] 微信本地库、附件       [公开来源] 资讯、论文、博客
           | wx / 解码                    | 采集、回原文
           v                              v
       raw.json -> input.json       候选 -> selection.json
                       \                 /
                        v               v
                  [配置的模型端点] 写初稿、读图、锐评
                                |
                                v
                [本机] 主编审核 -> 定稿 -> 榜单、网页验收
                                |
                          本期发布授权
                                v
            [公开] newspaper 读者数据 -> GitHub Pages
                                |
                       导览草稿（不自动发群）
```

| 阶段 | 主要入口 | 需要的判断 |
|---|---|---|
| 采集群聊和图片 | `pipeline/collect-batch.mjs`、`collect-images.mjs` | 账号、窗口、本地覆盖与图片质量 |
| 写各群初稿 | `scripts/prepare-week-d.mjs generate` / `package` | 选题、证据、观点归属与独立主题 |
| 补锐评、标题和重点 | `scripts/enrich-month-d.mjs` | 与正文一致，重点逐字匹配 |
| 外部资讯 | `scripts/collect-external.mjs`、`generate-external.mjs`、`generate-external-comments.mjs` | 补采各类来源、读原文、区分声明和验证 |
| 审核与定稿 | `scripts/apply-month-review.mjs`、`package-month-resources.mjs`、`finalize-batch.mjs` | 明确资料和讨论对应关系，批准确切候选 |
| 榜单 | `pipeline/prepare-release-activity.mjs` | 同日终窗口、原始条数、新头像审核 |
| 预览、入库与发布 | newspaper 的 `prepare-preview.mjs`、`publish-reviewed-batch.mjs` | 多视口与数据一致性，本期授权 |
| 线上核验、导览草稿 | `skill/scripts/verify-publication.mjs`、`scripts/generate-bot.mjs` | 部署提交、线上字节、链接和发布状态 |

文件名里的 `week`、`month` 不总是刊期类型。`prepare-week-d.mjs` 和 `enrich-month-d.mjs` 仍是当前批量日报入口。周报用 `generate-weekly-gemini.mjs`，按主题跨日合并，另有该周外部资讯、独立周榜和资料库增量，见[周报流程](skill/references/weekly.md)。

### 读消息与读图

采集以北京时间整日为窗口，每页 500 条，读到尾页才接受本次筛选结果；截断或重复页会报错。分页读尽只说明本次查询完整，不证明这台电脑保留了微信全部历史。入群前、其他设备独有或尚未同步的消息都可能缺失。`no_local_records` 不等于当天没人发言。

给模型的输入把发言者换成 `p1`、`p2` 等化名，并过滤账号、联系方式和凭据。正文中互相称呼的昵称可能仍在，公开前还要读内容并检查隐私。消息 ID、引用和逐日来源留作审核依据，相邻消息不能自动当作直接回复。

图片从客户端附件解码，模型描述图的类型及讨论涉及的文字和数字。缩略图可能丢失区域或认错小字，不能用描述中的数字代替原图核验。原始讨论面板保留 `[图片]`，不把模型描述当作群友原话。

### 模型与 prompt

当前生成器经 `lib/llm.mjs` 读取 OpenAI 兼容的 Chat Completions 配置。`DAILY_LLM_BASE_URL` 必填，`DAILY_LLM_MODEL` 默认是 `gemini-4-argon`，端点需要认证时设置 `DAILY_LLM_API_KEY`。不设置端点时不会请求默认服务。

模型可以替换，但应重新核对图片输入、推理参数、返回模型名、输出上限和 JSON 结构。当前代码的输出上限为 32768 token；群稿使用 `reasoning_effort: high`，周报和外部资讯的调用设置不同，见[操作手册](skill/references/runbook.md#模型)。这些调用条件不一定适用于其他模型。

根目录 `prompts/` 保留当前静态引用的 8 份指令。它们分别约束群稿、重点、锐评、报头、导览、周报、外部资讯和图片描述。初稿保留原始响应和运行记录，结构校验成功不代表事实审核完成。历史 prompt 与旧模型调用放在 `legacy/`，不用于证明当前 prompt 的质量收益。

### 说人话与编辑审核

正文写具体的事。核心讨论交代谁提出了什么、依据是什么、有哪些分歧、讨论停在哪里；轻分享和短讯靠后。按讨论深度排序，不按产品名气、消息数量或固定条数凑稿。

主编对照原文改正事实、归属、隐私、安全步骤、乱码和并题错误，不给每句话追加免责句。文字生硬或漏了话题时，把具体问题交回模型重写。AI 锐评可以接住细节，但不添加事实或把多人的经历拼成因果关系。

主编还要逐条审核 `emphasis`。每个承载独立判断的段落通常选 1 处，片段与正文逐字一致、互不重叠，合计不超过正文的 30%。正文变更后重新核对重点、锐评、资料、讨论和审核回执，详见[编辑标准](skill/references/editorial-standards.md)。

## 数据边界

| 数据 | 默认存放与使用 | 对外边界 |
|---|---|---|
| 微信数据库、wx 密钥、解密缓存、API 凭据 | 运行者管理的本机目录或密钥存储 | 不进入任何仓库 |
| 原始聊天、成员映射、完整活跃统计 | 本地私有批次，默认不上传 | 指定的去凭据副本可另获授权后存入指定私有仓库 |
| 模型输入与图片 | 本地批次 | 调用时发送到运行者配置的模型端点 |
| 模型响应、审核与覆盖证据 | 本地私有批次，默认不上传 | 私有归档须独立授权，不随公开构建发布 |
| 审核后的标题、正文、重点、锐评与资源 | newspaper 的读者数据 | 本期获准发布后公开 |
| 匿名讨论节选、前三名名次与审核过的头像 | 读者稿和公开榜单 | 本期获准发布后公开；原话和头像仍可能识别人 |

默认本地保存不表示禁止一切私有归档，也不构成归档授权。公开发布、私有存档和发群各有独立边界，凭据不因仓库私有就可以提交。

## 目录

| 目录 | 内容 |
|---|---|
| `skill/` | agent 的执行顺序、编辑标准、续跑与授权边界 |
| `pipeline/` | 群聊、图片、活跃榜和资料候选采集 |
| `scripts/` | 当前写稿、审核与打包工具 |
| `prompts/` | 当前静态使用的 8 份模型指令 |
| `lib/` | 模型配置、仓库定位、跨日身份与终稿审核校验 |
| `examples/synthetic/` | 不含真实聊天的离线示例输入 |
| `docs/` | 采集与定稿契约 |
| `config/` | 私有配置模板 |
| `legacy/` | 5 个历史脚本及历史 prompt，保留作手动实验与对照 |

## 测试

在 bot-workflow 根目录运行。

```sh
NEWSPAPER_DIR=/path/to/newspaper npm test
```

测试使用临时目录中的合成数据和本机的假模型端点，不读取真实微信消息或调用真实模型。资源脚本还有独立的离线测试。

```sh
node scripts/package-month-resources.mjs --self-test
```

这些检查不代替真实刊期的事实审核、头像审核和浏览器验收。浏览器和部署检查属于 newspaper 的生产流程。

## 使用须知

读取本机微信数据之前，先在所在群说明用途，取得群成员知情，并遵守群里的约定。wx CLI 读取的是运行者自己账号在本机已收到的数据。初始化涉及的客户端与权限改动，按所用版本的第三方文档由运行者自行决定。

## 许可证

本仓库使用 MIT 许可证，见 [LICENSE](LICENSE)。wx CLI 等第三方工具按各自的许可证使用。
