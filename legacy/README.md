# 历史脚本与 prompt

本目录保留 5 个早期试刊与实验脚本，以及历史编辑 prompt，供阅读与对照。它们不是当前生产入口，不应直接用于新刊期。当前流程见[根 README](../README.md)和[写稿脚本](../scripts/README.md)。

## 脚本分类

| 脚本 | 历史用途 | 依赖与限制 |
|---|---|---|
| `scripts/generate-daily.mjs` | 单次 Responses API 群稿 | 默认 `http://127.0.0.1:8549/v1`、`gpt-6-astra`，读取 `COPROXY_API_KEY`；与当前 Chat Completions 配置不同 |
| `scripts/generate-daily-claude.mjs` | 无工具的 Claude CLI 群稿 | 固定 `claude-opus-5-5`，默认 `low`；依赖当时的 CLI 参数、认证和输出格式 |
| `scripts/package-daily.mjs` | 把单日 `agent` / `llm` 试稿合成一期 | 读取 `<群>.input.json` 和 `<群>.<variant>.json`，不含当前整期审核和榜单流程 |
| `scripts/package-group-daily.mjs` | 在已有刊期上替换一群 | 固定 `group-1`、`.gemini.json` 和历史模型标记，不负责全部群的完整性 |
| `scripts/trial-autonomous-daily.mjs` | 自主选题与 D 系列 prompt 对照 | 仅接受代码中的历史日期；需要原来的 `scratch/prompt-trial/` 输入和试验目录 |

相对 import 已指向本仓库的 `lib/`。这几个脚本仍依赖单独的 newspaper 仓库；`NEWSPAPER_DIR` 的含义与当前流程相同。历史脚本没有复制到 `scripts/` 根目录的兼容入口。

## prompt 分类

| 路径 | 用途 |
|---|---|
| `prompts/daily-editor.md`、`prompts/daily-reader-copy.md` | 历史 Responses 生成器顺序拼接的两段指令 |
| `prompts/daily-editor-arguments.md`、`daily-editor-gemini-readable.md`、`daily-editor-readable-v2.md`、`daily-editor-value.md` | 手动选择的编辑实验变体 |
| `prompts/external-emphasis.md` | 外部资讯重点标注实验 |
| `prompts/trials/autonomous/` | 自主选题实验的公共指令与方向变体，共 8 份 |
| `prompts/trials/comments/` | 锐评文风实验，共 6 份 |
| `prompts/trials/editor-*.md` | 编辑实验，共 7 份 |

这些文件按用途归档，保留手动实验。`daily-editor.md`、`daily-reader-copy.md`、`daily-editor-gemini-readable.md`、`daily-editor-readable-v2.md` 和 `trials/editor-g.md` 的公开摘录已泛化具体示例或刊期提纲，不是原 prompt 的逐字副本。其中部分示例的来源尚未确认；泛化不表示已认定它们泄露真实聊天。其余保留原方案。当前脚本默认使用的 8 份 prompt 仍在根目录的 `prompts/`。脚本接受显式 prompt 文件时，运行者仍可选择历史变体；这不保证变体符合当前输出 schema 或编辑标准。

## 历史模型条件

这里保留了当时的模型名、固定端点和格式假设，没有把旧实验改写成当前生产结果。固定端点不属于默认生产流程。不要把当年使用过某个模型、单次 prompt 对照或渲染说明当作当前可用性或质量结论。

`trial-autonomous-daily.mjs` 从本目录读取 prompt，但调用当前的 `scripts/generate-daily-gemini.mjs`。运行时模型来自当前环境变量，渲染说明中的 Gemini 3.8 Flash 则是历史文字。直接重跑不能复现原来的模型条件，也不能沿用旧的文字介绍新结果。

如果确需回放，先检查本文件、目标脚本、所需的私有输入和两个仓库的版本。在独立批次中显式配置模型及端点，保留真实响应和条件。涉及真实群聊、模型请求或公开发布时，应分别取得授权。公开仓库不附带历史原始聊天、模型响应、账号配置或凭据。
