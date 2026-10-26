# 离线合成示例

这个示例用固定的本地响应，运行真实 CLI 到静态预览。新增的两天群稿、外部资讯、成员、榜单和头像全部为合成数据。newspaper 自带的历史公开内容仍会出现在预览中，不能把整站称为虚构。

## 运行

需要 Node.js 22.15 或更新版本、Git，以及已执行 `npm ci` 的干净 newspaper clone。bot-workflow 的运行脚本不需要额外 npm 依赖。默认从同级 `newspaper/` 加载库；不同位置用 `NEWSPAPER_DIR` 指定。

警告：newspaper 的 `prepare-preview.mjs` 会重建 clone 中的 `dist-preview/`。请使用专门的干净 clone，避免覆盖其他人的未提交预览。

1. 在 newspaper clone 安装锁定依赖。

   ```bash
   npm --prefix /path/to/newspaper ci
   ```

2. 在 bot-workflow 运行示例。

   ```bash
   node scripts/run-synthetic-example.mjs --out /tmp/bot-workflow-example
   ```

   newspaper 不在同级目录时，运行下面的命令。

   ```bash
   NEWSPAPER_DIR=/path/to/newspaper \
     node scripts/run-synthetic-example.mjs --out /tmp/bot-workflow-example
   ```

3. 查看命令输出中的 `runDirectory` 与 `previewDirectory`。

   每次运行建立新的 `run-*` 子目录，不删除旧运行。`run-*/result.json` 保存命令清单、固定模型调用次数和预览一致性检查。

4. 用客户端的本地静态预览功能打开 `previewDirectory`。

   只把该目录作为服务器根目录。入口为 `/newspaper/daily/2026-10-21/group-1/`，实际站点前缀以 newspaper 配置为准。脚本只准备文件，不启动静态服务器。

   资源卡查看 `/newspaper/daily/2026-10-20/group-1/`。默认的 10 月 21 日页面展示跨日引用的每日摘录，不重复挂资源卡；完整跨日身份和引用关系保存在 `weekly.json` 与私有审计。

`--out` 应显式给出。它只能是新目录，或含匹配 `.synthetic-example.json` 标记的既有示例目录。父目录应已存在。脚本拒绝符号链接、任意未标记目录，以及 newspaper clone 内部或包含该 clone 的目录。失败运行保留自己的 `run-*` 供排查，不会清空用户目录。

## 覆盖范围

| 路径 | 示例内容 |
| --- | --- |
| `prepare-week-d generate/package` | 两天五群，五群为空，其他群各一个固定话题 |
| `enrich-month-d` | 固定版头、锐评和重点响应 |
| weekly namespace、evidence、attach、select | 两位虚构成员跨日互换 `p1`、`p2`，保留四个日期范围内的身份与准确引用目标 |
| finalizer | 明确 `topic_key` 与当前 `feedbackId`、资源卡、匿名讨论、待审快照、显式审批、终稿 |
| external workflow | 固定合成来源、生成、锐评和完整审核凭证 |
| `prepare-preview` | 真实 newspaper 构建、内容与榜单一致性检查，关闭公开构建和反馈接口 |

示例中的 reviewer 名为 `Synthetic fixture reviewer (not human approval)`。脚本的 `--approve` 仅演示审批流程，不代表真实审稿人看过内容，更不代表允许发布。

资源链接指向 `example.org` 占位地址。它们只进入输入和读者稿，脚本不会抓取页面。固定外部来源中的时间、发布方和关注记录都是虚构证据，不能用来证明真实新闻。

榜单为固定 Top 3，页面各群的备注明确写出合成数据与虚构榜单。三个头像是程序自绘的双色方块，同时保存 PNG 和可编辑 SVG，不读取真实成员头像。

## 网络与文件边界

脚本只启动一个绑定 `127.0.0.1` 随机端口的测试 HTTP 服务，模拟 chat-completions API。所有模型 CLI 都指向该服务，响应模型名为 `synthetic-fixed-response`。脚本结束时关闭服务，不连接公网模型或微信。

子进程使用环境变量白名单。脚本不传入宿主的 `NODE_OPTIONS`、模型密钥、微信路径或代理变量，`HOME` 和临时目录都指向本次运行目录。父 Node 进程启动前执行的用户 preload 不在这个保护范围内；如需清除，启动时使用 `env -u NODE_OPTIONS node ...`。此脚本不是操作系统网络沙箱，不应执行来自不可信 clone 的脚本。

所有示例输入和审核文件写入 `--out/run-*`。唯一在 newspaper clone 中重建的是 `dist-preview/`，这是现有预览 CLI 的行为。脚本不改 `data/`，不调用发布器，不发送群消息，也不提交或推送代码。

`candidate.json`、`review.json`、`final/receipt.json` 和原始讨论审计是私有工作文件。示例虽无真实隐私，实际运行时这些文件可能包含原聊天全文。不要公开它们的父目录。finalizer 的真实批次契约见 [终稿说明](../../docs/finalize.md)。
