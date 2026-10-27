# 群稿定稿校验（finalize-batch.mjs）

模型写完初稿、主编改完错并挑好资料和讨论节选后，用 `scripts/finalize-batch.mjs` 校验并组装给网页构建用的 `issues.json`。

## 推荐的一步用法

把审改后的标题、正文、版头、`emphasis`、`aiComment`、`resources` 和 `discussion` 直接更新到 `$BATCH/issues.json`，或者把附件整理成 `$BATCH/attachments.json`，然后跑一步命令：

```bash
# 直接校验 $BATCH/issues.json 并写出 $BATCH/final/issues.json：
node "$BOT/scripts/finalize-batch.mjs" "$BATCH"

# 或将 $BATCH/attachments.json 合并进 $BATCH/issues.json 并写出 $BATCH/final/issues.json：
node "$BOT/scripts/finalize-batch.mjs" --directory "$BATCH" --attachments "$BATCH/attachments.json"
```

脚本会直接检查：

- 当天所有有读者版面的群都在 `issues.json` 里（群列表来自 `newspaper/lib/groups.mjs`），当天没内容的群留空 `stories: []`。
- 每条故事都有合法的 `emphasis` 下划线片段（逐字唯一匹配、不跨自然段、不重叠、总长不超过正文 30%）和 `aiComment`。
- `resources` 只含支持的五种类型（`paper`、`article`、`code`、`demo`、`discussion`），且 URL 是无账号密码、无追踪参数的 `https://` 地址。
- `discussion` 符合匿名讨论格式（`speaker` 从 1 开始、`time` 为 `HH:mm`、不含模型读图文本）。
- 全文不含微信号、群号、密钥、手机号或本机路径。

## 使用 `attachments.json` 挂载附件（可选）

如果习惯把资料链接、原始讨论、重点和 AI 锐评单独放在 `attachments.json` 里，脚本支持按 `feedbackId`、`title` 或 `topic_key` 自动匹配对应条目，改过正文后无需手动重算 32 位 `feedbackId`，也不需要填写 `resourceEvidence` 或被删条目的 `exclude` 记录：

```json
{
  "version": 1,
  "stories": [
    {
      "date": "2026-10-20",
      "group": "group-1",
      "topic_key": "offline-notebook",
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

兼容旧版的 `candidate` / `review` / `finalize` 三步子命令仍然保留，但日常跑报直接用上面的一步命令即可。
