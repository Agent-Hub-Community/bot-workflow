# 微信采集与榜单脚本（pipeline）

这里的脚本直接读取本机 `wx` CLI 解密后的微信缓存（SQLite + 附件目录），**不调用任何外部模型 API**。

## 环境变量

- `WX_ACTIVITY_HOME`：已解密的微信账号 HOME（包含 `.wx-cli/config.json` 与 `.wx-cli/cache/`）。
- `NEWSPAPER_DIR`（可选）：`newspaper` 仓库路径，默认自动定位到旁边的 `../newspaper`。

## 核心脚本

- `collect-batch.mjs FROM THROUGH BATCH_DIR`：按北京时间自然日导出所有配置群的 `<date>/<group>.raw.json` 与 `<group>.input.json`。
- `collect-images.mjs YYYY-MM-DD BATCH_DIR`：纯本地解码微信 `.dat` 图片到 `<date>/media/<group>/<id>.<ext>`，并写入 `<group>.images.json` 和 `input.messages[i].image.file`。Antigravity subagent 写稿时直接用 `read_file` 看图，打包时自动挂载进讨论记录。
- `prepare-release-activity.mjs BATCH_DIR [--date YYYY-MM-DD]`：计算各主群日榜及社区周/月/总榜，自动过滤微信占位头像；可在写稿前由 `daily.mjs collect` 直接运行。
- `prepare-weekly-rank.mjs BATCH_DIR`：计算自然周各群独立 Top 3 周榜。
- `collect-library-candidates.mjs` / `collect-opportunity-candidates.mjs` / `collect-glossary-chunks.mjs`：每周资料库、机会、黑话候选采集。
