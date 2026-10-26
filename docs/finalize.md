# 群稿终稿与审核凭证

`finalize-batch.mjs` 把已编辑群稿与明确指定的附件合成待审快照。reviewer 审阅快照后，显式运行 `review --approve`，再由 `finalize` 校验当前输入并生成终稿。三个步骤均不调用模型或网络，不改原稿，也不写 newspaper 的 `data/`。

审核凭证用于发现修改和漏审，不验证 reviewer 的身份，也不代替事实核验。任何能写本地文件的人都能生成凭证。发布仍需要维护者针对当前刊期的明确授权。

## 输入契约

批次目录保留 package 阶段的布局。日期按实际刊期填写。

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

`issues.json` 保存当前编辑后的群稿，包括标题、正文、版头及排序。finalizer 要求日期对应的全部读者群，空组保留空 `stories`。群列表取自 newspaper 的 `lib/groups.mjs`。外部资讯走已有 external workflow，不放进这份群稿输入。

每个 `.draft.json` 应保留 `topic_key`、`evidence_ids` 和 `claims`。每条证据应存在于同日同群 `.input.json`。这些私有字段不进入最终 `issues.json`。

附件 manifest 单独保存。每条当前稿件都要明确指定下面的四元组。

```text
(date, group, topic_key, feedbackId)
```

`topic_key` 指向原 draft 的话题，`feedbackId` 指向当前标题和正文。finalizer 调用 newspaper 的 `feedbackId(date, group, story)`，不按标题相似度或文章序号猜配对。首次建立映射也由编辑明确指定。改标题或正文后，应重新计算该条的 `feedbackId` 并更新映射。

下面的 manifest 是形状示例，`feedbackId` 需要替换为实际计算值。

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
        { "speaker": 1, "time": "10:00", "text": "经审核的匿名原话。" }
      ],
      "emphasis": ["逐字匹配的原文片段"],
      "aiComment": "经审核的完整锐评。"
    }
  ]
}
```

`resources`、`discussion`、`emphasis` 和 `aiComment` 应全部明确提供。前三项可用 `[]` 表示不附加内容。manifest 覆盖当前稿件的这些字段，避免旧附件留在终稿里。资源类型 `kind` 只接受读者页面可显示的 `paper`、`article`、`code`、`demo`、`discussion`。资源 URL 默认应出现在该话题的证据中，并满足 HTTPS、无凭据、无查询参数的读者契约。程序不访问 URL，也不证明资源与结论相符，reviewer 应核验两者。

如果从原分享页核实了不同的官方地址，在该条 manifest 增加 `resourceEvidence`。每项包含 `url`（采用地址）、`sourceUrl`（该话题证据中的原地址）、`reviewer`、`reviewedAt`（ISO 时间）和 `basis`（核验依据）。例如，编辑读过转发页及项目官网后，写明原页如何指向项目。无核验记录时，finalizer 拒绝原证据中没有的地址。记录也进入完整审核快照；修改依据或地址后需要重审。

匿名讨论使用 newspaper 的 `validateStoryDiscussion` 契约。它只接受 `speaker`、`time`、`text`、可选 `quote`。每日时间用 `HH:mm`；引用含 `speaker` 和 `text`。私有来源标识留在输入或讨论审计中。结构校验不能证明引文忠实，也不能自动识别人名，reviewer 应对照证据检查隐私与归属。

删除话题后，应删除读者稿中的对应条目，并在 manifest 明确排除原话题。

```json
{
  "date": "2026-10-20",
  "group": "group-1",
  "topic_key": "removed-topic",
  "exclude": true,
  "reason": "编辑决定删除的具体原因"
}
```

每个原话题应恰好出现一次，每条当前稿件也应恰好匹配一次。缺项、重复项、未知话题和过期 `feedbackId` 均会失败。新增话题需要对应的模型 draft 和输入证据；不要给无来源稿件补造映射。

## 三步执行

警告：candidate 与 receipt 包含完整私有输入和原稿，不应提交到公开仓库或放入静态预览目录。

1. 生成待审快照。

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" candidate \
     --directory "$BATCH" --attachments "$BATCH/attachments.json" \
     --out "$BATCH/candidate-v1.json"
   ```

   candidate 的状态是 `pending`。`snapshot.issues` 是将要生成的完整读者稿，其他字段保留输入、来源和映射供核对。

2. 审阅完整快照后，显式记录 reviewer。

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" review \
     --candidate "$BATCH/candidate-v1.json" \
     --reviewer "实际审稿人" --approve --out "$BATCH/review-v1.json"
   ```

   无 `--approve` 或无 reviewer 时不会生成凭证。该命令不重新读批次目录，签署的是给定 candidate 中的准确快照。

3. 用当前输入和凭证生成终稿。

   ```bash
   node "$BOT/scripts/finalize-batch.mjs" finalize \
     --directory "$BATCH" --attachments "$BATCH/attachments.json" \
     --review "$BATCH/review-v1.json" --out "$BATCH/final"
   ```

   结果为 `final/issues.json` 和 `final/receipt.json`。finalizer 先验证全部输入，再一次性建立输出目录，失败不会留下半份终稿。

这些命令要求输出父目录已存在。输出路径已存在时，只允许内容一致的幂等重跑，不覆盖其他内容。后续可在 `final/` 增加榜单与预览文件；重跑 finalizer 仍只核对 `issues.json` 与 `receipt.json`。

任何原输入、原 draft、manifest、当前稿件或终稿变化，都会让旧凭证失效。即使 `feedbackId` 没变，修改锐评、资源标签、匿名讨论、重点、版头或文章顺序，也需要新 candidate 和新审核。使用新的 `candidate-v2.json`、`review-v2.json` 和 `final-v2/`，不要改旧凭证。

## 接入榜单与预览

预览应读取 `final/issues.json`，不要继续读取定稿前的 `BATCH/issues.json`。finalizer 的凭证仅覆盖群稿及附件，不覆盖后续榜单和头像。

单日真实批次的榜单采集器还需要同日输入。完成授权后，复制原日目录到终稿目录，再按现有榜单流程采集和审核。下面的 `DATE` 是该批次唯一日期；`prepare-release-activity.mjs` 不支持一次输入多日。只在目标日目录不存在时复制，防止重复运行时嵌套目录。

警告：下面的榜单命令会读取本机微信数据。离线合成示例不运行该命令，它使用明确标为虚构的固定榜单和自绘头像。

```bash
test ! -e "$BATCH/final/$DATE" && cp -R "$BATCH/$DATE" "$BATCH/final/$DATE"
WX_ACTIVITY_HOME="$WX_HOME" node "$BOT/pipeline/prepare-release-activity.mjs" "$BATCH/final"
```

1. 完成榜单和新增头像审核。
2. 按 external workflow 生成、审阅同日外部资讯。
3. 调用 newspaper 的现有预览命令。

   ```bash
   node "$NEWSPAPER_DIR/scripts/prepare-preview.mjs" \
     --date "$DATE" --batch "$BATCH/final" \
     --external-draft "$EXTERNAL_DRAFT" --external-selection "$EXTERNAL_SELECTION"
   ```

   newspaper 会更新自身 `dist-preview/`，并把静态文件复制到 `final/preview/`。它不启动静态服务器，也不改正式 `data/`。只有 `final/preview/` 可以作为静态服务器根目录，不要暴露包含 receipt 的父目录。

现有 newspaper 的独立发布器不读取本 finalizer 的 receipt。绕过 finalizer 或在定稿后修改 `issues.json`，不会由发布器自动检测。维护者发布前应重新运行 finalizer 核对，并执行 newspaper 原有发布检查。本改动不改变历史刊期的 publish gate，也不授权发布、推送或发群。
