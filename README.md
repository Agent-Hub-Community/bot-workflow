# bot-workflow

[Agent Hub 社区日报](https://agent-hub-community.github.io/newspaper/)每天整理各群讨论，并附上一页外部资讯。本仓库是日报和周报的采集与写稿工具：从本机微信读群聊、解图片，抓外部资讯，调模型写初稿，再由人或 agent 对照原文改错、审隐私、出预览。

网页本身在 [newspaper](https://github.com/Agent-Hub-Community/newspaper)。本仓库只管前面的采集、写稿和审核；`newspaper` 负责 schema 校验、静态页面构建和发布。出真实日报时，选题、补查和审稿都要过一遍脑子，没有一键自动发布的命令。

| 想看什么 | 入口 |
|---|---|
| 不接微信和模型，先跑通一遍 | [安装](#安装)、[合成示例](#合成示例) |
| 怎么从微信读消息、读图、算榜单 | [采集说明](docs/collection.md)、[`pipeline/`](pipeline/README.md) |
| 怎么调模型写稿、补锐评、选讨论 | [`scripts/`](scripts/README.md)、[`prompts/`](prompts/) |
| 怎么把改好的稿件、资料和讨论锁成终稿 | [定稿说明](docs/finalize.md) |
| 让 agent 跑一期日报或周报 | [`skill/SKILL.md`](skill/SKILL.md)、[操作手册](skill/references/runbook.md)、[`Agent-Hub-Community/skills`](https://github.com/Agent-Hub-Community/skills) |
| 早期的实验脚本和旧 prompt | [`legacy/`](legacy/README.md) |

## 安装

推荐 Node.js 24，最低 22.15（采集脚本用到了 `node:sqlite` 和 Node 22.15 新增的 [`zstdDecompressSync`](https://nodejs.org/docs/latest-v22.x/api/zlib.html#zlibzstddecompresssyncbuffer-options)）。本仓库不装自己的 `node_modules`，直接复用 `newspaper` 装好的依赖。

1. 把两个仓库克隆到同一个父目录。

   ```sh
   git clone https://github.com/Agent-Hub-Community/newspaper.git
   git clone https://github.com/Agent-Hub-Community/bot-workflow.git
   ```

   ```text
   work/
   ├── newspaper/       网页、读者数据和发布脚本
   └── bot-workflow/    采集、写稿和审核工具
   ```

2. 在 `newspaper` 安装依赖。

   ```sh
   cd newspaper
   npm ci
   cd ../bot-workflow
   ```

3. 记下常用路径变量。

   ```sh
   export BOT="$PWD"
   export NEWSPAPER_DIR="$(cd ../newspaper && pwd)"
   export NEWSPAPER="$NEWSPAPER_DIR"
   export PIPELINE="$BOT/pipeline"
   ```

如果两个仓库不在同一级目录，用 `NEWSPAPER_DIR` 指定 `newspaper` 的路径；不设时，`lib/newspaper-root.mjs` 默认找旁边的 `../newspaper`。日常命令大多在 `$NEWSPAPER` 下跑，相对路径按当前目录解析。

### 合成示例

`examples/synthetic/` 里有一套编好的两天群聊和固定模型返回。跑一遍能看到输入、初稿、终稿和预览网页分别长什么样，不需要微信、API Key 或 Cloudflare 账号。

预览构建会改写所指 `newspaper` 克隆下的 `dist-preview/`，不要和真刊期的预览混用同一个克隆；正式的 `data/` 不会动。`--out` 放在 `newspaper` 外面，每次运行会在下面新建一个 `run-*` 目录。

```sh
node scripts/run-synthetic-example.mjs --out "$BOT/../synthetic-example"
```

跑完会打印 `runDirectory`、`finalDirectory` 和 `previewDirectory`，并写入 `result.json`。你可以对着[定稿说明](docs/finalize.md)翻看 `final/issues.json`。注意：预览站里除了合成的 10 月 20、21 日内容，还带着 `newspaper` 仓库原有的公开往期页面。

## 跑真刊期的准备

警告：写稿和读图会把群聊文字、图片发给你配置的模型接口。跑之前先跟群里说清楚用途，并确认接口方的数据政策。化名和正则过滤只能挡掉明显标识，正文里仍可能带出身份细节，公开前要人工通读。

1. 按[采集说明](docs/collection.md)自己安装并初始化 [wx CLI](https://github.com/jackwener/wx-cli)。本仓库不会替你跑 `sudo`、重签名或重启微信。
2. 给目标微信账号单独准备一个 HOME 目录，确认能列出群、也能读到最近的消息。光看会话列表不够，消息库没解开时列表照样能出。

   ```sh
   export WX_HOME=/path/to/your/wx-account-home
   HOME="$WX_HOME" wx sessions --json -n 20
   HOME="$WX_HOME" wx history '<数字>@chatroom' --json -n 20
   ```

3. 复制群配置模板，填进各群的 `<数字>@chatroom`。

   ```sh
   cp pipeline/groups.example.mjs pipeline/groups.private.mjs
   ```

   群名、何时开始采集、何时出读者版面都在 `newspaper/lib/groups.mjs` 里定义；`groups.private.mjs` 只放微信群号 `<数字>@chatroom`。

4. 复制环境变量模板，填好路径和模型接口后加载。密钥可以在运行命令时从自己的密钥管理工具注入，不要写进会提交的文件。

   ```sh
   cp config/env.example .env.local
   set -a; . ./.env.local; set +a
   ```

5. 如果要在本地跑浏览器测试或自动截图，在 `newspaper` 安装 Chromium。读图还需要本机有 `ffmpeg`。

   ```sh
   cd "$NEWSPAPER"
   npx playwright install chromium
   ```

6. 把 `skill/` 挂到你用的 agent。以 Claude Code 为例：

   ```sh
   ln -s "$BOT/skill" "$HOME/.claude/skills/agenthub-daily"
   ```

7. 对 agent 说“生成昨日完整日报”。默认只做到本地预览和导览草稿，不会自己推上线或发到群里。

## 一期日报是怎么出来的

```text
[本机微信] 聊天库与图片附件             [公开来源] 新闻、论文、博客
        | wx 导出 / 解码                        | 抓取、回读原文
        v                                      v
  raw.json -> input.json                 候选 -> selection.json
                 \                             /
                  v                           v
             [模型接口] 读图、写初稿、写锐评、拟报头
                              |
                              v
          [主编] 对照原话改错、选重点、挂资料与讨论、定稿
                              |
                              v
          [本机] 算活跃榜、审新头像、合成预览并检查页面
                              |
                         获准发布本期
                              v
          [公开] 写入 newspaper/data/ -> GitHub Pages
```

| 阶段 | 脚本 | 人或 agent 要盯的事 |
|---|---|---|
| 采集群聊与图片 | `pipeline/collect-batch.mjs`、`collect-images.mjs` | 选对账号和北京时间整日窗口，看分页有没有读到底、关键图是不是只有缩略图 |
| 写群稿初稿 | `scripts/prepare-week-d.mjs generate` / `package` | 有没有漏掉重要讨论、把两件事合成一条，或把甲的话安到乙头上 |
| 补锐评、报头和重点 | `scripts/enrich-month-d.mjs` | 锐评有据可依，重点片段能在正文里逐字找到 |
| 外部资讯 | `scripts/collect-external.mjs`、`generate-external.mjs`、`generate-external-comments.mjs` | 补查脚本没扫到的来源，点开原文核对时间和数据 |
| 审稿与定稿 | `scripts/finalize-batch.mjs` | 把资料链接和原始讨论挂到对应条目，校验 schema 与隐私后写出终稿 |
| 活跃榜 | `pipeline/prepare-release-activity.mjs` | 与群稿用同一个截止时刻，逐张看新上榜头像 |
| 预览与发布 | `newspaper` 的 `prepare-preview.mjs`、`publish-reviewed-batch.mjs` | 检查手机和桌面排版；拿到本期发布同意后再入库推送 |
| 线上核对与导览文案 | `skill/scripts/verify-publication.mjs`、`scripts/generate-bot.mjs` | 核对线上数据与本地一致，生成发群用的导览草稿 |

注意脚本名字里的 `week` 和 `month` 是早期留下的叫法：`prepare-week-d.mjs` 和 `enrich-month-d.mjs` 现在就是日常跑单日或几日日报的主入口。真正的周报用 `generate-weekly-gemini.mjs` 和 `weekly-*.mjs`，做法见[周报说明](skill/references/weekly.md)。

### 怎么读消息和图片

采集按北京时间自然日切窗口，每次翻页 500 条，一直翻到不满 500 条的尾页才算读完；中途截断或两页重复会直接报错。不过“翻到尾页”只说明这台电脑本地库里的记录读完了——入群前的消息、只在手机上收到的消息不在库里，脚本也读不到。看到 `no_local_records`，只代表本机没查到记录，不能直接当成群里那天没人说话。

给模型的 `input.json` 会把发言人按当天说话先后换成 `p1`、`p2`，并清掉微信号、群号、手机号、密钥和本地路径；但群友在句子里互相叫名字没法靠正则清干净，审稿时还得肉眼看。原始讨论节选只在单条话题内部把人编成“群友 1”“群友 2”，不同话题之间不打通。

微信客户端只给点开或滑过的图存原图，没看过的往往只有长边一两百像素的缩略图。`collect-images.mjs` 解出图片后请视觉模型写客观描述，塞进 `input.json` 的 `image` 字段供写稿参考；而公开的原始讨论面板只取 `content` 里的 `[图片]`，不会把模型写的描述当成群友原话展示出来。缩略图很容易看错小字和数字，审稿时遇到关键数字要回原图核对。

### 用什么模型和 prompt

生成脚本都通过 `lib/llm.mjs` 调 OpenAI 兼容的 `/chat/completions` 接口：`DAILY_LLM_BASE_URL` 必填，`DAILY_LLM_MODEL` 默认 `gemini-4-argon`，需要鉴权时设 `DAILY_LLM_API_KEY`。

我们日常用 `gemini-4-argon` 跑：写群稿开 `reasoning_effort: high`，输出上限设在 32768 token；外部资讯和周报不开推理（经验说明见[操作手册](skill/references/runbook.md#模型)）。你可以换成别的模型，换之前确认一下它吃不吃图片输入、推理参数怎么传、会不会把输出 token 用在思考上导致正文截断。

根目录 `prompts/` 下是当前线上在用的 8 份 prompt：

| 文件 | 作用 |
|---|---|
| [`daily-group.md`](prompts/daily-group.md) | 把单群一天的聊天写成日报条目 |
| [`daily-emphasis.md`](prompts/daily-emphasis.md) | 选出正文里值得加下划线的重点短句 |
| [`daily-comment.md`](prompts/daily-comment.md) | 给每条写一句接梗又有信息量的 AI 锐评 |
| [`daily-headline.md`](prompts/daily-headline.md) | 拟每版的报头和副题 |
| [`daily-bot.md`](prompts/daily-bot.md) | 写发到群里的合并导览文案 |
| [`weekly-editor-gemini.md`](prompts/weekly-editor-gemini.md) | 跨天整理一个群的一周讨论 |
| [`external-editor.md`](prompts/external-editor.md) | 从核实过的外部候选中选编行业日报 |
| [`image-description.md`](prompts/image-description.md) | 为群聊图片生成脱敏的文字描述 |

早期的 prompt 迭代和对比实验放在 `legacy/prompts/`，留作翻阅，生产流程不再调用。

### 为什么读起来不像套话

prompt 和审稿规则卡了四件事：

1. 按讨论有多深来排先后——有人追问、有来回交锋、有具体数字和踩坑细节的话题排前面；只甩个链接没人接话的放后面，三言两语带过。
2. 第一句直接说事，谁试了什么、结果怎样、别人怎么反驳，聊到哪一步算哪一步，不在结尾加“引发深思”“未来可期”之类的总结。
3. 分歧和猜测靠动词交代归属（“分享者测下来……”“有人怀疑……”），一处不确定说一次就停，不准在段尾反复贴“这只是个人猜测、尚未证实”的免责条。
4. 审稿只改错（事实、张冠李戴、隐私、乱码、把两件事揉成一条），如果整段话写得干巴或漏了重点，把问题写清楚让模型重写，不在半成品上硬贴补丁。详见[编辑标准](skill/references/editorial-standards.md)。

## 哪些文件能公开

| 内容 | 平时放在哪 | 能不能公开 |
|---|---|---|
| 微信数据库、wx 密钥、解密缓存、API Key | 本机目录或密钥管理工具 | 绝不进任何仓库 |
| 原始聊天 `raw.json`、成员映射、完整活跃统计 | 本机私有批次目录 | 不公开；去凭据副本只有另行同意时才归档到私有库 |
| 去敏输入 `input.json`、解码后的群聊图片 | 本机批次目录 | 写稿时发给所配模型接口，不进公开仓库 |
| 模型原稿、审稿记录 | 本机批次目录 | 含原文证据，留在私有目录，不放进预览站或公开仓库 |
| 定稿后的标题、正文、重点、锐评、公开资料链接 | `newspaper/data/` | 经当期同意后公开发布 |
| 匿名讨论节选、前三名名次与审过的头像 | `newspaper/data/` | 经当期同意后公开发布；注意原话和头像仍可能让人认出是谁 |

## 目录结构

| 目录 | 说明 |
|---|---|
| `pipeline/` | 读微信消息、解图片、算活跃榜、筛资料和机会候选 |
| `scripts/` | 写稿、补锐评与重点、挂资料与讨论、定稿 |
| `prompts/` | 现用 8 份模型 prompt |
| `lib/` | 模型调用、仓库路径查找、跨日讨论身份与定稿校验 |
| `skill/` | 给 agent 用的日报／周报流程说明与核验脚本 |
| `examples/synthetic/` | 不依赖微信和模型的离线合成示例 |
| `docs/` | 采集细节与定稿接口说明 |
| `config/` | 环境变量模板 |
| `legacy/` | 5 个早期脚本与 28 份历史实验 prompt |

## 测试

在仓库根目录跑：

```sh
NEWSPAPER_DIR=/path/to/newspaper npm test
node scripts/package-month-resources.mjs --self-test
```

测试全部用临时目录里的假数据和本机 loopback 假模型服务，不碰真实微信和外部接口。

## 使用提醒

读取群聊前，请先在群里说清楚用途、征得大家知情，并遵守群规。wx CLI 读的是你自己登录在本机的微信数据；要不要安装、重签名或提取密钥，由运行者自己看清第三方工具说明后决定。

## 许可证

代码采用 [MIT 许可证](LICENSE)。
