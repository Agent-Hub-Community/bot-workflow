# 群稿定稿与审核回执

模型写完初稿、主编改完错并挑好资料和讨论节选后，用 `scripts/finalize-batch.mjs` 把它们组装成最终给网页构建用的 `issues.json`。

它分三步走：`candidate` 先把正文、原始证据和要挂载的附件打包成一份待审快照；审稿人看过快照后，跑 `review --approve` 签出一份回执；最后 `finalize` 核对当前目录和回执一字不差，才写出 `final/issues.json` 和 `final/receipt.json`。三步都不联网、不调模型，也不去改原始初稿或 `newspaper/data/`。

说明白一点：这份回执是防手滑用的——比如改了正文忘了更新重点、或者挂错了别的群的讨论，脚本能立刻拦住。但它不是密码学签名，任何能写本机文件的人都能跑命令生成回执；真正能不能推上线，还是看维护者对当期内容的人工把关。

## 目录与输入

批次目录保持 `prepare-week-d.mjs package` 跑完后的结构（日期换成实际刊期）：

```text
BATCH/
  issues.json
  2026-10-20/
    group-1.input.json
    group-1.draft.json
    ...
    group-5.input.json
    group-5.draft.json
```

- `issues.json` 是当前改定后的群稿（标题、正文、版头和文章顺序）。当天所有有读者版面的群都要在里面（群列表来自 `newspaper/lib/groups.mjs`），当天没内容的群留空 `stories: []`。外部资讯走它自己的导入脚本，不放在这里。
- 每个群的 `.draft.json` 保留模型当初给的 `topic_key`、`evidence_ids` 和 `claims`，里面引用的消息 ID 都能在同日同群的 `.input.json` 里找到。这些内部字段只用来对账，不会进最终的 `issues.json`。

要挂到每条稿子上的资料链接、原始讨论、重点和 AI 锐评，单独写成一个 `attachments.json`。每条稿子靠下面四个字段对号入座：

```text
(date, group, topic_key, feedbackId)
```

`topic_key` 对应 `.draft.json` 里的原始话题，`feedbackId` 由 `newspaper/lib/feedback-id.mjs` 根据当前日期、群、标题和正文算出。脚本不靠标题长相或排列顺序去猜哪条对哪条；如果你改了某条的标题或正文，`feedbackId` 就会变，记得同步更新 `attachments.json` 里的对应值。

`attachments.json` 长这样：

```json
{
  "version": 1,
  "stories": [
    {
      "date": "2026-10-20",
      "group": "group-1",
      "topic_key": "offline-notebook",
      "feedbackId": "0123456789abcdef0123456789abcdef",
      "resources": [
        {
          "kind": "article",
          "label": "示例项目",
          "url": "https://example.org/notebook"
        }
      ],
      "discussion": [
        { "speaker": 1, "time": "10:00", "text": "审过的匿名原话。" }
      ],
      "emphasis": ["正文里逐字出现的片段"],
      "aiComment": "审过的 AI 锐评。"
    }
  ]
}
```

几个字段的要求：

- `resources`、`discussion`、`emphasis` 和 `aiComment` 四个字段都要写全；前三个如果某条没有，就显式写成 `[]`。脚本会拿这里的内容覆盖 `issues.json` 上的同名字段，免得残留旧数据。
- `resources[].kind` 只认网页能画出来的五种：`paper`、`article`、`code`、`demo`、`discussion`。URL 得是無账号密码、无查询参数的 `https://` 地址，而且默认要在该条目的原始证据消息里逐字出现过。
- 如果群友发的是带追踪参数的分享链接，或者你在转帖里核实到了官方主站地址，需要在该条下面加一段 `resourceEvidence`，写明采用的地址 `url`、证据里的原地址 `sourceUrl`、审核人 `reviewer`、ISO 时间 `reviewedAt` 和核实依据 `basis`。没有这条记录，脚本不收证据里没出现过的新 URL。
- `discussion` 用 `newspaper` 的讨论校验规则：只留 `speaker`（从 1 开始的整数）、`time`（`HH:mm`）、`text` 和可选的 `quote`（`{ speaker, text }`）。
- 如果审稿时删掉了初稿里的某个话题，除了从 `issues.json` 拿掉，还要在 `attachments.json` 里显式记一笔排除，这样脚本知道你是故意删的，不是漏配了：

```json
{
  "date": "2026-10-20",
  "group": "group-1",
  "topic_key": "removed-topic",
  "exclude": true,
  "reason": "两句闲聊，没有实质信息"
}
```

初稿里的每个 `topic_key` 和当前 `issues.json` 里的每条故事都得刚好对上一次，多一条、少一条或 `feedbackId` 算不上都会报错。

## 三步命令

警告：`candidate` 和 `receipt` 文件里打包了完整的私有聊天输入和模型原稿，只留在本机批次目录，不要放进预览静态站或提交到公开仓库。

1. 生成待审快照：

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" candidate \
     --directory "$BATCH" --attachments "$BATCH/attachments.json" \
     --out "$BATCH/candidate-v1.json"
   ```

   生成的 `candidate-v1.json` 里，`snapshot.issues` 就是组装后的读者稿，`snapshot` 的其余字段存着输入和证据供核对。

2. 看过快照确认无误后，签出审核回执：

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" review \
     --candidate "$BATCH/candidate-v1.json" \
     --reviewer "实际审稿人" --approve --out "$BATCH/review-v1.json"
   ```

   这一步只对指定的 `candidate-v1.json` 盖章，不重读目录。

3. 对照当前目录和回执，输出终稿：

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" finalize \
     --directory "$BATCH" --attachments "$BATCH/attachments.json" \
     --review "$BATCH/review-v1.json" --out "$BATCH/final"
   ```

   校验通过后会一次性写出 `$BATCH/final/issues.json` 和 `$BATCH/final/receipt.json`。

哪怕标题和正文一字未改（`feedbackId` 没变），只要你动过锐评、重点、资料链接、讨论节选、版头或者文章顺序，旧回执都会失效，需要重新走一遍 `candidate-v2` → `review-v2` → `final-v2`。

## 接着跑活跃榜和本地预览

定稿之后，后面的榜单和预览都针对 `$BATCH/final` 跑，别再用外层未定稿的 `$BATCH/issues.json`。

单日批次算活跃榜时，`prepare-release-activity.mjs` 还要读同目录底下的日期子目录。先把当天的输入目录拷进 `final/`，再算榜、审头像、合预览：

```bash
test ! -e "$BATCH/final/$DATE" && cp -R "$BATCH/$DATE" "$BATCH/final/$DATE"
WX_ACTIVITY_HOME="$WX_HOME" node "$BOT/pipeline/prepare-release-activity.mjs" "$BATCH/final"

node "$NEWSPAPER_DIR/scripts/prepare-preview.mjs" \
  --date "$DATE" --batch "$BATCH/final" \
  --external-draft "$EXTERNAL_DRAFT" --external-selection "$EXTERNAL_SELECTION"
```

起本地静态服务器看预览时，根目录指到 `$BATCH/final/preview/`，不要指到上一层 `$BATCH/final/`（上一层有 `receipt.json` 和原始输入）。

另外，`newspaper` 现有的 `publish-reviewed-batch.mjs` 入库脚本是为了兼容早期批次写的，本身不读 `receipt.json`。正式发布前，先重跑一次 `finalize-batch.mjs finalize` 确认终稿和回执仍然一致，再执行入库。
