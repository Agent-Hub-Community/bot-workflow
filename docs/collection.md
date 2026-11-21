# 采集与静态媒体挂载说明

## 1. 微信消息采集

采集按北京时间自然日（`00:00` 到次日 `00:00`）切窗口，每页翻 500 条直到尾页：
- `<date>/<group>.raw.json`：保留原始消息与发送者信息，仅留在本地私有批次目录。
- `<date>/<group>.input.json`：将发言人按当天先后编号为 `p1`、`p2` 供写作与讨论截选使用。

## 2. 纯本地媒体提取与自动挂载（图片 / 视频 / 文件）

微信客户端会在本地保存已浏览的图片（`.dat` 加密）、视频与封面（`msg/video/`）及已下载文件（`msg/file/`）：
1. `pipeline/collect-images.mjs` 纯本地提取当天所有可用媒体到 `<date>/media/<group>/`：
   - 图片：本地解 `.dat`（非 jpg/png/webp 用 `ffmpeg` 转 jpg），写入 `input.json` 的 `image: { quality, file }`；
   - 视频：优先提取标准 `.mp4`（无则取 `_raw.mp4`）与 `.jpg` 封面；
   - 文件：按文件名和 MD5 从 `msg/file/` 匹配所有可下载附件（默认单文件上限 10 MB，可通过 `MAX_ATTACHMENT_MB` 调整；超大文件自动跳过仅保留文件名与大小卡片）。
   - 仅当消息被选进日报/周报讨论或故事正文时，打包脚本才会把对应附件复制进 `attachments/` 上传；未被选中的群聊文件不会入库。
   同时写出 `<date>/<group>.media.json`（并保留 `<group>.images.json`），不再调用外部视觉模型 API。
2. Antigravity subagent 写群稿时直接用 `read_file` 查看解码后的本地图片，并可在 `draft.json` 的 `image_alts` 中写入简短说明。
3. `scripts/package-daily.mjs` 按内容 MD5 去重把图片、视频、封面与文件复制到 `BATCH/attachments/{media,files}/`，自动挂载到每条讨论记录；`newspaper` 构建时打包并在讨论面板渲染图片预览、原生视频播放器、封面预览与带原文件名的下载卡片。
4. 对历史已发布日报和周报，可随时运行 `WX_ACTIVITY_HOME=/Users/haoqing node "$BOT/scripts/backfill-media.mjs"` 批量补挂本机已有媒体与文件。
