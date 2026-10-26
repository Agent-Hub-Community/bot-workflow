# 群聊采集、读图与活跃榜

这篇文档讲 `pipeline/` 怎么从本机微信读出群聊、图片和活跃榜数据，以及跑之前要准备什么。每个脚本的参数表见 [`pipeline/README.md`](../pipeline/README.md)。

## 前提

- 这套脚本只在 macOS 的微信 4.x 上跑过，读图直接依赖微信 4.x 的附件目录结构。
- 电脑上要登录一个已经进群的微信账号。脚本只能读到这个账号在这台电脑上已经收下来的消息；进群前的聊天、只在手机或另一台电脑上收到的消息，本地库里没有，脚本也拿不到。
- 开跑前先在群里打声招呼，见 [README 的使用提醒](../README.md#使用提醒)。

## 1. 安装和初始化 wx CLI

[wx CLI](https://github.com/jackwener/wx-cli) 是开源的本机微信查询工具（Apache-2.0）。微信 4.x 用 SQLCipher 加密本地数据库；按 wx CLI 的说明，它会从运行中的微信进程内存里扫出数据库密钥，按需解密并缓存在本地。

要不要装、要不要重签名或提取密钥，由运行者自己决定。本仓库的脚本和 skill 不会自动跑 `sudo`、重签名、杀进程或重启微信。

警告：如果电脑上同时挂着大小号，初始化前先核对清楚目标进程是哪一个，不要光看进程名叫 `WeChat` 就扫。

1. 按你所装版本的 [wx CLI README](https://github.com/jackwener/wx-cli) 完成安装。
2. 给负责采集的微信账号单独建一个 HOME 目录（下面记作 `$WX_HOME`）。wx CLI 会把密钥和解密缓存放在 `$HOME/.wx-cli/`；单开一个目录，就不会和你平时用的默认配置串掉。之后每条 `wx` 命令前面都加上 `HOME="$WX_HOME"`。
3. 在微信客户端里逐个点开目标群，往上滑几屏。聊天库（`message_0.db`、`message_1.db` 等）的密钥只有客户端真正点开过聊天后才会留在内存里；刚启动微信还没点过群时去扫，往往会漏掉主消息库。
4. 按 wx CLI 文档在 `$WX_HOME` 下初始化，确认扫出了包含 `message_0` / `message_1` 在内的数据库密钥。平时直接读就行，只有确认旧密钥失效了才需要重扫。
5. 试读一下群列表和最近消息：

   ```sh
   HOME="$WX_HOME" wx sessions --json -n 20
   HOME="$WX_HOME" wx history '<数字>@chatroom' --json -n 20
   ```

   `wx sessions` 里形如 `<数字>@chatroom` 的字段就是群号，填进 `pipeline/groups.private.mjs`。

`$WX_HOME`、`.wx-cli/`、`all_keys.json` 和任何密钥都只留本机，别提交进仓库，也别打进日志。

### 常见报错

| 现象 | 原因与处理 |
|---|---|
| 报 `找不到联系人` | 忘了加 `HOME="$WX_HOME"`，读到了默认 HOME 下另一个账号。 |
| 报 `file is not a database` | 解密缓存坏了或过期。跑 `HOME="$WX_HOME" wx daemon stop`，删掉 `$WX_HOME/.wx-cli/cache/` 再试。 |
| 导出 0 条，或者最新消息停在好几天前，但微信里明明有人说话 | 多半是主聊天库密钥没扫出来，或者缓存还停在旧库。去微信里点开群往上滑几下，清掉 cache，必要时重跑一次初始化。 |
| `wx init` 报 `task_for_pid` 失败 | 目标微信进程没法读内存（没按 wx CLI 要求签名，或找错了进程）。按 wx CLI 文档排查。 |

数据没拿齐之前，不要硬跑写稿脚本生成空报或半截日报。

## 2. 按天导出群聊

`collect-daily.mjs`（以及批量包装它的 `collect-batch.mjs`）按群、按天导出消息：

- 时间窗口是北京时间当天 `00:00` 到次日 `00:00`（左闭右开）。如果当天还没过完就跑，`completeDay` 会记成 `false`。
- 每次调 `wx history <chatroom> --since D --until D+1 -n 500 --offset K --json` 翻一页，直到某页不满 500 条为止。如果连续两页一模一样，或者翻满 10000 条还没见底，脚本直接报错退出，不会留下一份半截文件。
- 多天采集时一天天串行跑，写进 `$BATCH/<日期>/`。同一个微信账号不要并发读库。

每群每天落两个文件（目录权限 `0700`，文件权限 `0600`）：

| 文件 | 里面是什么 | 干什么用 |
|---|---|---|
| `group-N.raw.json` | `wx` 导出的原始记录，带群昵称 | 留在本机，供审稿核对原话和发言人 |
| `group-N.input.json` | 脱敏后的模型输入 | 喂给写稿脚本、做榜单条数核对 |

`input.json` 给每条消息编上 `m0001`、`m0002`，把发言人按当天第一次说话的顺序换成 `p1`、`p2`（每天每群重新从 `p1` 排起）。正文里的密钥参数、手机号、邮箱、群号、微信号和本机路径会被替换掉，解不开的 XML 媒体统一变成 `[媒体引用未解析]`。不过群友在聊天里直呼其名的昵称替换不掉，审稿时要自己看。

`coverage` 字段记着当天有没有本地记录（`local_records` / `no_local_records`）、是不是完整自然日、分页读到底没有、一共多少条、首末条时间。注意：`no_local_records` 只代表这台电脑没查到记录，不能据此断定那天群里没人说话。

## 3. 解码图片与写图说

`collect-images.mjs` 在导出文字之后、调模型写稿之前跑，给当天每张群聊图片补一段客观文字说明。

1. 找文件：从解密缓存库里查出图片的 md5，去微信账号的 `msg/attach/` 目录底下找对应的 `.dat` 文件。
2. 解码：微信把图片做成异或加密的 `.dat`（V2 首尾段用账号派生密钥，V1 用固定密钥，老版本单字节异或）。脚本在内存里算出密钥解成常见图片格式，不把密钥写盘。遇到 wxgf 或动图会调 `ffmpeg` 转成 JPEG。
3. 分辨原图和缩略图：只有有人在这台电脑的微信上点开或滑到过这张图，本地才会有清晰原图；否则只有自动拉下来的缩略图（长边一两百像素，超长图还会只裁中间一截）。
4. 调视觉模型：按 `prompts/image-description.md` 让模型写出这是什么图、图里有哪些和讨论相关的文字与数字。prompt 要求忽略人名、昵称、头像、二维码、微信号和网址；个人主页只写“某平台个人主页”。脚本拿到返回后还会再扫一遍漏网的链接、微信号和 `@`。
5. 写回输入：解出来的图存在 `$BATCH/<日期>/media/`。图说写进 `input.json` 对应消息的 `image` 字段，`content` 保持 `[图片]` 不动。写稿脚本发请求前才把 `image` 拼成 `[图片（原图）：……]` 或 `[图片（缩略图）：……]` 给模型看；而网页上的原始讨论面板只读 `content`，读者看到的仍是 `[图片]`。
6. 缓存：图说按 md5 缓存在 `scratch/image-descriptions/`。重跑时只补上次失败的、或者后来在微信里新点开变清晰的图。注意：如果重跑了 `collect-batch.mjs`，`input.json` 会被重写，得再跑一遍 `collect-images.mjs` 把图说填回去。

缩略图上的小字和数字十有八九会看走眼。审稿时别拿缩略图里的数字当真；要是哪张图特别关键，去微信里滑到那张图让它加载出原图，再重跑一次读图。

## 4. 活跃榜

活跃榜只数发言次数，不管发言内容好坏。榜单脚本和读图脚本一样，以只读方式查 `$WX_HOME/.wx-cli/cache/`，所以要先跑完当天采集再算榜。

- 成员键：对微信 `username` 算 SHA-256 取前 12 位十六进制（`memberKey`），只在私有统计和核对时用，不进公开数据。
- 去重：按服务端消息 ID 跨分库去重。
- 计分：文字、引用回复、图片、视频、语音、链接卡片、文件和合并转发，每条算 1 次；系统提示、拍一拍和表情包不计。
- 统计口径：各群日榜按群单算；社区周榜（北京时间自然周）、月榜（自然月）和总榜把已纳入采集的群合起来算。总榜只代表这台电脑留存下来的历史。
- 截止时间：刊期次日北京时间 `00:00`（不含）。

公开的 `snapshot.json` 只留前三名名次和重新编过的 `member-NNN`，不带名字、微信号、发言条数或计分明细。脚本会把上榜成员的头像下载到本地，新头像要一张张肉眼看过、把 `avatar-review.json` 里的 `pending` 清空后才能发布；碰到微信返回“暂时无法查看”的灰图，就当没头像处理，页面用默认占位图。

## 5. 资料库、机会与黑话候选

每周出周报时，顺带从这一周的群聊里捞三类候选：

- 资料库候选（`collect-library-candidates.mjs`）：扫群里发过的外部链接，带上前后几句聊天上下文；设了 `WX_ACTIVITY_HOME` 时还会记下分享者的成员哈希和头像地址。我们自己用来发日报、转外链的运营号哈希配在 `groups.private.mjs` 的 `libraryOperators` 里，脚本会把它标成运营转发，只有没别的群友发过同一链接时才算数，而且不挂运营号头像。
- 机会候选（`collect-opportunity-candidates.mjs`）和黑话分块（`collect-glossary-chunks.mjs`）：直接从每天的 `input.json` 抽，不再读微信库。
- 候选文件都带聊天上下文，只放在 `newspaper/scratch/` 下。怎么审、怎么合进 `newspaper/data/`，看 `newspaper` 仓库的 [`docs/review/library.md`](https://github.com/Agent-Hub-Community/newspaper/blob/main/docs/review/library.md)、[`opportunities.md`](https://github.com/Agent-Hub-Community/newspaper/blob/main/docs/review/opportunities.md) 和 [`glossary.md`](https://github.com/Agent-Hub-Community/newspaper/blob/main/docs/review/glossary.md)。
