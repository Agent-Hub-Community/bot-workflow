# 编排与打包脚本（scripts）

所有写稿、看图、锐评、报头和导览由 Antigravity（Gemini）及其并行 subagent 直接完成。这里的脚本全部是纯确定性本地工具，**不调用任何外部 LLM HTTP 接口**。

## 日报主入口：`daily.mjs`

```sh
node "$BOT/scripts/daily.mjs" collect "$D" [--batch DIR] [--external DIR] [--from-step STEP] [--dry-run]
node "$BOT/scripts/daily.mjs" finish  "$D" --batch DIR [--external DIR] [--dry-run]
node "$BOT/scripts/daily.mjs" publish "$D" --batch DIR [--external DIR] [--reports DIR] [--verify] [--dry-run]
```

- **`collect`**：串行跑完 3 个读微信库的步骤（`collect-batch` → `collect-images` 纯本地解图 → `prepare-release-activity --date D`），同时并行抓外部资讯基础候选（`collect-external`）。
- **`finish`**：跑 `package-daily.mjs`（打包各群 `draft.json`、自动裁剪不合法 `emphasis`、自动挂载讨论与图片/视频/语音/文件附件、输出 `bot-input.json`）和 `newspaper/scripts/prepare-preview.mjs`（本地预览）。
- **`publish`**：跑 `newspaper/scripts/release.mjs`、提交推送 `data/`、等待 GitHub Actions 部署、将导览草稿标题改为“日报已上线”。

## 其他脚本

- `package-daily.mjs YYYY-MM-DD BATCH_DIR [--external EXTERNAL_DIR]`：单跑日报打包与媒体挂载（图片、视频、封面、文件均按内容 MD5 去重挂载）。
- `fetch-link-previews.mjs [--batch BATCH_DIR]`：为讨论里的裸链接增量抓取 OpenGraph / oEmbed 标题与摘要写入 `newspaper/data/link-previews.json`，生成 IM 风格富链接卡片。
- `backfill-media.mjs [--dry-run]`：扫描已发布的全部历史日报与周报，将本机微信缓存里可找到的图片、视频、封面和文件批量补挂到 `newspaper/data/attachments/`（幂等，可随时重跑）。
- `check-bot.mjs BOT_INPUT_JSON MESSAGE_MD [--fix]`：校验并规范化 Antigravity 写出的微信群导览文案格式与字数。
- `collect-external.mjs YYYY-MM-DD EXTERNAL_DIR`：抓取 AIHOT / HF / alphaXiv / HN / X 基础候选。
- `assemble-weekly-reader.mjs BATCH --from FROM --through THROUGH`：组装各群周报页面与周榜。
- `weekly-attach-discussions.mjs READER_JSON INPUT_DIR EVIDENCE_DIR AUDIT_JSON`：按 subagent 产出的 `evidence.json` 挂载跨日匿名讨论。
