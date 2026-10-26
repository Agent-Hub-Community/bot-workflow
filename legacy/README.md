# 早期脚本与实验 prompt（legacy）

这里收着日报早期迭代时写过的 5 个旧脚本和 28 份实验 prompt，留作翻阅和对照。现在的日常生产已经不用它们了；当前在跑的流程看[根 README](../README.md) 和 [`scripts/README.md`](../scripts/README.md)。

## 旧脚本

| 脚本 | 当初干什么用 | 为什么不再用于日常生产 |
|---|---|---|
| `scripts/generate-daily.mjs` | 早期用 Responses API 调 `gpt-6-astra` 写单群日报 | 绑死了旧本地端口 `8549` 和两段式旧 prompt，已被 `generate-daily-gemini.mjs` 替代 |
| `scripts/generate-daily-claude.mjs` | 用无工具的 Claude CLI（`claude-opus-5-5`）写单群日报 | 早期对比实验用，依赖当时的 CLI 参数与认证 |
| `scripts/package-daily.mjs` | 把单日 `agent` / `llm` 对比稿合成一期 | 没有现在的整期审稿、重点修复和活跃榜流程 |
| `scripts/package-group-daily.mjs` | 只重跑并替换一期里的 `group-1` | 写死了 `group-1` 和旧文件名，不检查全群完整性 |
| `scripts/trial-autonomous-daily.mjs` | 跑 A/B/C/D 几套 prompt 的横向对比 | 只认代码里写死的几个历史日期和当时的 `scratch/prompt-trial/` 目录 |

这些脚本里的相对 import 已经改指本仓库的 `lib/`，但没有在 `scripts/` 根目录留转发入口。注意：还在 `scripts/` 里的 `prepare-week-d.mjs` 和 `enrich-month-d.mjs` 虽然名字带 week / month，但它们是现役主力脚本，不是旧文件。

## 历史 prompt

| 路径 | 内容 |
|---|---|
| `prompts/daily-editor.md`、`daily-reader-copy.md` | 最早给 Responses API 用的两段式指令（先选编，再改写读者文风） |
| `prompts/daily-editor-arguments.md`、`daily-editor-gemini-readable.md`、`daily-editor-readable-v2.md`、`daily-editor-value.md` | 摸索“怎么把聊天写得像人话、少掉新闻腔和免责套话”时的几版改稿 |
| `prompts/external-emphasis.md` | 外部资讯重点标注的早期单拆版 |
| `prompts/trials/autonomous/` | 自主选题实验（公共规则 + A/B/C/D/D1/D2/D3 七个方向变体） |
| `prompts/trials/comments/` | AI 锐评口吻实验（接话、冷面、温和、尖锐、回复、松弛 6 个变体） |
| `prompts/trials/editor-*.md` | 早期编辑取向实验（A 到 G 共 7 份） |

公开前，我们把其中几份含有当时具体刊期提纲或示例句子的文件（`daily-editor.md`、`daily-reader-copy.md`、`daily-editor-arguments.md`、`daily-editor-gemini-readable.md`、`daily-editor-readable-v2.md`、`trials/editor-g.md`、`trials/autonomous/a.md`）改成了通用表述，并在文件头标了一句说明；其余保持原样。当前线上实际调用的 8 份 prompt 在仓库根目录的 [`prompts/`](../prompts/)。
