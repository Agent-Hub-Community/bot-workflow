# 操作手册

变量的含义见 [SKILL.md](../SKILL.md#路径与环境)。下文的 `D` 是已确定的刊期日期；`$BATCH` 是新建的单日批次目录，例如 `$NEWSPAPER/scratch/day-D-run2`；`$EXTERNAL` 是本轮外部资讯目录。所有命令都要换成实际值。旧目录只作证据，不覆盖已审核的稿件。

采集脚本以 bot-workflow 仓库 `pipeline/README.md` 的当前说明为准，写稿脚本以 `scripts/README.md` 为准；newspaper 的入库和发布脚本以该仓库 `docs/publishing.md` 为准。本手册的命令在 `$NEWSPAPER` 下执行：`node scripts/…` 是 newspaper 仓库的脚本，`node "$BOT/scripts/…"` 是 bot-workflow 仓库的脚本。

## 1. 定位与运行前核对

- 两个仓库克隆在同一个父目录。bot-workflow 的脚本通过 `NEWSPAPER_DIR` 找到 newspaper 仓库，不设置时默认 bot-workflow 旁边的 `../newspaper`。
- 检查两个工作树的 remote、HEAD、未提交改动和脚本是否存在。不要盲用旧的 checkout，也不要为了整理日报重建工作树。Node.js 最低为 22.15，推荐 24（采集链用 `node:sqlite` 和 `zstdDecompressSync`）。
- 核验 wx CLI 账号：`HOME="$WX_HOME" wx sessions --json -n 20` 能列出目标群。初始化、密钥提取、清缓存和重置账号由运行者本人按 bot-workflow 仓库的 `docs/collection.md` 操作，agent 不自动执行。
- 群的公开信息只写在 `$NEWSPAPER/lib/groups.mjs`：id、读者名称、采集起始日期 `from`、是否有版面 `page`、版面起始日期 `pageFrom`。每个群的 chatroom username 和运营账号哈希写在 `$PIPELINE/groups.private.mjs`。不要在脚本里另写一份群列表。
- `page: false` 或还没到 `pageFrom` 的群照常采集、生成草稿，成员也计入社区周 / 月 / 总榜，但不进 `issues.json`，不出读者版面；`prepare-week-d.mjs package` 按 `pageGroups(D)` 过滤。要让一个群上版面，把 `page` 改成 `true` 并设置 `pageFrom`，再按第 5 节检查手机布局能否容纳新的版面数。
- 新刊期采集 `collectedGroups(D)` 里的全部群。历史批次按当时已采集的输入和正式刊期页确定覆盖，不能用空文件补造历史。

### 模型

所有生成脚本经 `$BOT/lib/llm.mjs` 读取模型名、端点和输出上限。端点是 `DAILY_LLM_BASE_URL`（OpenAI 兼容，脚本在后面拼 `/chat/completions`），模型名是 `DAILY_LLM_MODEL`（默认 `gemini-4-argon`），密钥是 `DAILY_LLM_API_KEY`。

- 在同一条命令里从你自己的密钥存储临时导出密钥，例如 `DAILY_LLM_API_KEY="$(<读取密钥的命令>)" node …`。不要把密钥写进文件，不要打印它。
- 先用最小请求确认返回的 `model` 正是 `$BOT/lib/llm.mjs` 指定的模型。不改代理或客户端配置。
- 批次专用的模型调用（周报分片、修订等）用 `node "$BOT/scripts/call-llm.mjs" PROMPT OUTPUT [--system FILE] [--reasoning high] [--max-tokens N]`。不要复制旧批次里写死模型名或端点的临时脚本。

下面是示例模型 gemini-4-argon 在参考端点上的已知行为（2026 年 10 月观察）。换模型或端点时，先重新确认这些上限和行为。

- 群稿请求带 `reasoning_effort: high`。大群一次约 4 到 5 分钟、2 万到 3 万输出 token；多个群并行时整批约 5 分钟。不开推理时，模型会把不相关的话题拼成一条。这个模型只有 `high` 会推理，`low`、`medium` 等同不推理。
- 参考端点的输出上限是 32768 token，推理也计入。脚本统一用 `llmMaxOutputTokens`。`max_tokens` 写得更大时，端点会在上限处截断却仍报 `stop`，所以不要在临时脚本里调高。群稿报 `length` 说明推理用光了上限：重跑一次，仍失败就记录阻塞。
- 外部资讯和周报不开推理。
- 模型复制原文不够逐字，重点片段常差一两个字。`prepare-week-d.mjs` 会先自动带 `--repair-emphasis` 修复，再决定是否整篇重跑。外部资讯脚本删掉不合格片段，并在 `.run.json` 的 `emphasisTrimmed` 里列出条目。锐评脚本给模型发编号，再映射回条目 id。审稿时另外留意偶发的外文乱码、繁体字和过长的合并条目。

### 批次规则

首次运行先检查目标刊期是否已经正式发布，以及是否已有同一输入的审核稿。续跑复用本轮已完成的产物；用户明确要求重写时才另开修订目录。工作跨过午夜时不改 `D`。

同一账号的群稿采集和榜单数据库读取要串行。独立的外部来源和模型调用可以并行。发布、合并预览、写正式数据和共享构建目录由主 agent 单独执行。

## 2. 群稿、标题与锐评

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" "$D" "$D" "$BATCH"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-images.mjs" "$D" "$BATCH"
node "$BOT/scripts/prepare-week-d.mjs" generate "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/prepare-week-d.mjs" package "$D" "$D" "$BATCH" --emphasis
node "$BOT/scripts/enrich-month-d.mjs" "$BATCH"
```

逐步执行并检查结果，不要把这组命令当作无条件的串行脚本。`collect-images.mjs` 也要求 `DAILY_LLM_API_KEY`。`$WX_HOME` 必须是刚核验过的账号 HOME。

采集后核对日期覆盖、分页是否读到尾页、是否截断、输入条数、去重和日终截止时刻。分页读尽只证明本次本地筛选读完，不证明微信全部历史都在本机。起止同日的查询返回异常空结果时，不能解释成当天零消息。采集方法和输出字段见 `$BOT/docs/collection.md`。

### 读图

`collect-images.mjs` 在采集之后、生成之前运行。它为每条图片消息找到客户端保存的图片，解码到 `$BATCH/D/media/`（目录权限 0700，文件 0600），再让模型逐张写客观描述。

- 描述写进 `group-N.input.json` 对应消息的 `image` 字段，`content` 仍是 `[图片]`。只有群稿和周报生成器在发给模型前把它换成 `[图片（缩略图）：描述]`。原始讨论节选从 `content` 取原话，仍显示 `[图片]`。
- 逐张的质量、来源文件和描述在 `group-N.images.json`；`coverage.images` 记录总数、原图数、缩略图数、缺失数和已描述数。脚本退出码非零时，看它列出的失败项。
- 描述按图片 md5 缓存在 `scratch/image-descriptions/`。失败后直接重跑，只补失败或新打开的图。重跑采集会覆盖 input，之后要再跑一次读图。
- 客户端只为显示过的图片保存原图，其余只有收到时自动下载的缩略图，长边一两百像素。关键图片只有缩略图时，可以请运行者在微信客户端里打开该群、滚动经过这些图片后重跑。agent 不操作微信界面。

### 写稿

`prepare-week-d.mjs generate` 按实际输入并行生成各群初稿。群稿 prompt 由 `$BOT/prompts/daily-group.md` 和 `daily-emphasis.md` 组合，批次目录里的 `prompt.md` 是实际发出的内容。`enrich-month-d.mjs` 补充 AI 锐评、报头和重点；确切产物以当前实现为准。

- 检查每份原稿的实际 `model`、`finish_reason` 和结构校验结果。生成失败时保留成功的部分，按脚本的有界重试处理。模型不可用就报告生成受阻，不用主 agent 写的稿冒充模型稿。
- `--resume` 只检查 schema 和输入 ID，不能证明用了新的 prompt。要求重写时用新目录或新输出路径，把审稿意见交给模型；不得把旧的成功响应冒充本轮结果。
- 历史单群更新器在 `$BOT/legacy/scripts/package-group-daily.mjs`，不用于新刊期。旧的 `publish-reviewed-draft.mjs` 也不用于新刊期。使用上面的批量流程和 `publish-reviewed-batch.mjs`，不要为绕过完整性校验改走旧入口。历史脚本和 prompt 的分类见 `$BOT/legacy/README.md`。

### 审稿

按[编辑标准](editorial-standards.md)审核选题、顺序、事实归属、隐私、标题、锐评和重点。

- 审稿记录的格式见 `$BOT/scripts/README.md`，用 `$BOT/scripts/apply-month-review.mjs` 应用，再用 `month-report.mjs`、`package-month-resources.mjs`（同在 `$BOT/scripts/`）整理。
- 正文修改后刷新关联的 story revision，重新生成或核对锐评和重点。不要只改展示文字而留下旧的审核绑定。
- `package-month-resources.mjs` 要求显式批次目录，只输出 `resources.json` 和审计候选，不会自动挂到读者稿。默认离线，带 `--fetch` 才访问链接。审核后，在附件清单中写明原始 `topic_key` 与当前 `feedbackId` 的对应关系。
- 用 `$BOT/scripts/finalize-batch.mjs` 的 `candidate`、`review --approve`、`finalize` 三阶段生成定稿，精确命令和回执规则见 `$BOT/docs/finalize.md`。主编先读候选和证据，再批准确切候选。脚本只写新的定稿目录，不替主编判断事实或授权发布。正文、资料或讨论改变后重新生成候选和回执，预览时确认附件实际显示。
- 提前运行资料 URL 校验，规则见编辑标准的“资料链接”。正文或标题改动后必须重算 revision；只改 URL 也要重新检查最终预览，不能沿用旧的合并数据。

## 3. 外部资讯

先读[资讯补查](external-sources.md)和 `$NEWSPAPER/docs/external-news.md`。

```sh
node "$BOT/scripts/collect-external.mjs" "$D" "$EXTERNAL"
node "$BOT/scripts/generate-external.mjs" "$EXTERNAL/selection.json" "$EXTERNAL/draft.json"
node "$BOT/scripts/generate-external-comments.mjs" "$EXTERNAL/draft.json" "$EXTERNAL/commented-draft.json"
```

采集和生成之间，agent 要补采、回原文、选题并写 `selection.json`，不能直接连跑。当前的采集脚本不覆盖全部必查来源。按当前 schema 保留 edition、timezone、windowStart、cutoff、来源全文或摘录、时间和拒稿理由。

需要并行重写时，按互不重叠的候选拆分，由主 agent 合并并做跨稿去重。使用现有的生成模块和 prompt，不猜测脚本支持并发参数。遵守 schema 的条数范围，不额外塞稿绕过检查。

每次调用都输入原始来源和结构约束。把整篇旧稿交给模型可能导致照抄；需要从头重写时用新的输出路径、不传修订参数，优先提供原始材料。增量修订时，两个脚本都接受第三个参数（审稿意见文件），但输出要求不同：

- `generate-external.mjs` 传第三个参数时会读取输出路径上的已有稿。要保留原稿，先把待改稿复制到独立的修订路径，再以该路径为输出调用；路径不存在会报错。
- `generate-external-comments.mjs` 的输出必须是新路径。输入仍指向待补或待改锐评的稿件，不能预先复制到输出位置。

并行任务使用各自独立的输入、输出和响应文件。更换正文、锐评或证据后重新审核。

获得正式采用的授权后才执行：

```sh
node scripts/review-external.mjs "$FINAL" "$EXTERNAL/selection.json" "$EXTERNAL/review-record.json" "$REVIEWER" --approve
node scripts/import-external-report.mjs "$FINAL" "$EXTERNAL/selection.json" "$EXTERNAL/review-record.json"
```

`$FINAL` 必须是含已审核锐评的稿件。`$REVIEWER` 如实写实际审核者，不能冒写用户已审批。审核记录绑定确切的稿件和候选。读者字段导入 `data/external-editions/`，原始证据留在 scratch。

## 4. 活跃榜

后续步骤使用定稿目录，不再读取未定稿的 `$BATCH/issues.json`。以下命令假设第 2 节已定稿到 `$BATCH/final`，且本次只有 `D` 一天。复制前检查 `$BATCH/final/$D` 尚不存在；续跑时核对已有输入，不把目录再嵌套复制一遍。日期目录保留在私有批次中，不进入公开仓库。

```sh
RELEASE_BATCH="$BATCH/final"
cp -R "$BATCH/$D" "$RELEASE_BATCH/$D"
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/prepare-release-activity.mjs" "$RELEASE_BATCH"
```

此后将 `$BATCH` 设为 `$RELEASE_BATCH`，本手册余下的预览、发布和交付命令均使用定稿批次。来源目录、候选和审核回执仍保留在原位置，详见 `$BOT/docs/finalize.md`。

```sh
BATCH="$RELEASE_BATCH"
```

发布级的榜单采集只接受单日的 `$BATCH/issues.json`，还要求 `$BATCH/D/group-N.input.json`。它按刊期页确定纳入的群，以次日北京时间零点为排他截止，计算各群日榜和社区周 / 月 / 总榜。它校验榜单与群稿输入同日、同群、同截止时刻、同原始条数，并保留已有的历史日榜、公开键和头像。新上版面的群只新增本期日榜，不回填历史空榜。

检查 `$BATCH/activity/snapshot.json`、`avatar-review.json` 和 `private-audit.json`。打开每张新增头像查看实际像素，处理无效头像后再清除审核的 pending 列表；不能只为了通过门禁清空 pending。获取失败的头像用默认图，不补造身份或名次。私有审计不进入公开构建。

最新刊期发布时，周 / 月 / 总榜窗口的 through 必须等于刊期，当天有版面的每个群都必须有当日日榜。历史修订和补报按原刊期的群覆盖，保留已上线的较新社区榜截止日，不回退到旧刊期。“总榜”只覆盖本机保留的历史，不代表微信的全部历史。历史日榜和旧头像的字节不能无故变动。


## 5. 本地预览与验收

本地预览统一用仓库脚本生成，不要每期复制临时的整合脚本：

```sh
node scripts/prepare-preview.mjs --date "$D" --batch "$BATCH" \
  --external-draft "$EXTERNAL/reviewed-final.json" --external-selection "$EXTERNAL/selection.json" \
  --base "http://127.0.0.1:$PORT/newspaper"
```

它调用 `build.mjs --draft … --draft-activity … --draft-external …`，在构建时合并已审的资讯草稿（不改正式的 `data/external-editions/`，不绕过授权）。然后它断言本期构建结果与 `issues.json` 加资讯审核稿逐项相同、活跃榜与快照相同，把结果复制到 `$BATCH/preview/newspaper/`，并写出 `final-reader-issue.json` 和 `integration-validation.json`。资讯还没审完时，可以先不带两个 `--external-*` 参数预览群稿。只做群稿预览时也可以直接运行 `npm run build -- --draft "$BATCH/issues.json" --draft-activity "$BATCH/activity/snapshot.json"`。本地预览不开启生产反馈。需要服务器时，以 `$BATCH/preview` 为根目录启动静态服务，交付实际 URL。

`dist*/data.js` 是索引（日期、各版名称、是否有稿和版本号），每期正文在 `issues/<date>.js`。Node 端用 `lib/built-data.mjs` 的 `readBuiltData(dist)` 读取完整数据。不要手改 `dist-preview/data.js` 或自己重写深链页。共享的 `dist-preview` 只允许一个写入者，构建时不与验收并发。

### 验收内容

- 目标日期的每个群版面、外部资讯，以及 week / month / all 榜单页。
- 320、390、820、1440 宽度的实际截图：各版页签布局、无水平溢出、文字不重叠、头像可解码、锐评 / 重点 / 链接、保存图片。另查 700px 和 701px 的断点：日报群稿在 701px 及以上为等宽双列，700px 及以下单列，标题在正文上方。外部资讯和周报按各自的布局验收。
- 日期导航：当前群缺稿时切到当天有稿的版面，整期无稿才跳日；历史日期不出现当时还没有的群的假稿。
- 原始讨论：每条末尾有“原始讨论 N 条 · M 人”按钮。点开后桌面是左栏导读、右栏聊天记录，平板从右侧滑出，手机全屏；返回键、Esc、关闭按钮和遮罩都能关闭；`#discussion-N` 能直接打开对应讨论。

```sh
VERIFY_SITE="http://127.0.0.1:$PORT/newspaper" DISCUSSION_DATE="$D" node test/discussion-browser.mjs
```

周报页另跑 `VERIFY_SITE=… node test/weekly-browser.mjs`。`npm run test:browser` 可能含有已经失效的旧断言；失败时先对照 HEAD 判断是否由本次改动引入，不要据此回退界面。复用浏览器测试前先看日期是否写死，测试必须针对 `D` 和本期的实际条数。

对比预览的正文和活跃榜与审核产物。公开构建新增的 `feedbackId` 可以从比较中剔除，其他差异不能剔除。固定历史日期的测试不能证明本期正确。

HTTP 预览要提供 `/newspaper/` 下的真实目录文件，未知日期真正返回 404，不能用 SPA fallback 掩盖缺失的目录。检查新路径直接打开和刷新、旧 hash 链接迁移、前进后退、查询参数、`#topic-N`、缺稿回退和长图导出。保持已确认的常规主题和原有的隐私 / noindex 策略，不顺手重新设计界面或增加 SEO 功能。

## 6. 获准发布后的执行

先检查本轮刊期的授权是否覆盖正式采用和发布。历史的发布记录和完善流程文档的授权都不构成本期的发布授权。导览文案默认只准备不发群；发群和合并 PR 分别需要明确授权。

发布前，用原始批次、附件清单和已审回执重跑 `finalize-batch.mjs finalize`，输出仍指向本次定稿目录，确认内容没有改变。newspaper 发布器不会读取该回执，不能依赖发布器发现定稿后被改动的字段。定稿回执含私有输入，不放进静态预览或公开仓库，详见 `$BOT/docs/finalize.md`。

新刊期：采用已审核的最终资讯稿，确认名次和头像门禁通过，然后执行：

```sh
node scripts/publish-reviewed-batch.mjs "$BATCH"
FEEDBACK_API_URL="$FEEDBACK_API_URL" npm run build -- --public
node scripts/embed-catalog.mjs
npm test
node test/build.mjs --public
```

`publish-reviewed-batch.mjs` 会写 `data/editions/`、`data/public-activity/`，并清理不再使用的公开头像，所以必须在获准正式采用之后运行。检查 diff，确认证据、私有审计和无关文件没有泄露，历史数据没有被误删。

`embed-catalog.mjs` 为新话题生成站内语义检索用的向量（Cloudflare Workers AI），更新 `data/semantic-vectors.json`，随本期一起提交。它使用 `CLOUDFLARE_API_TOKEN`，没有时使用本机 wrangler 登录取得的令牌；一期日报约 30 条，耗时约 10 秒（2026 年 10 月）。它失败时（例如 wrangler 未登录）不阻塞发布：新话题仍能按词面搜到。报告缺口，下次发布时补上。公开构建提示“N catalog entries have no semantic vector”就表示漏了这一步。

### 历史修订与补报

历史文案修订：获得采用授权后，只更新对应 `data/editions/` 的最终读者稿；外部版重新审核后用外部导入脚本。保留 `data/public-activity/` 不变，不调用 `publish-reviewed-batch.mjs`，也不为通过它的 through 门禁把社区榜回退到旧日期。纯界面修改同样不经过批次入库。之后执行上面的公开构建、测试和下面的发布步骤；新增或变更了反馈标识时核对反馈目录。

较旧日期的补报：先保存当前社区榜和全部历史日榜、头像的基线。群稿、外部稿和该日期的日榜仍须完整采集和审核。当前发布器要求社区榜 through 等于刊期，不能直接调用它覆盖较新的榜单。如果仓库没有保留社区榜的补报入口，要先实现并测试一个范围受限的入库路径：只新增目标日期的读者稿和该刊期纳入群的日榜，沿用私有身份映射分配不冲突的公开键，复制已审核的新头像；当前的 windows、ranks、generatedAt、其他日期的日榜和所有已引用头像的字节保持不变。不能直接混合两个独立编号的快照。缺少身份映射或无法证明历史不变时，完成内容和本地预览后明确报告入库受阻，不声称支持自动补报发布。日常的最新刊期不走这个分支。

### 反馈目录

按 `$NEWSPAPER/feedback/README.md` 用 `feedback-catalog.mjs` 登记新增的赞踩条目，保留旧的赞踩数据。远端数据库写入必须在本次发布授权的范围内。

先选一个当前可用的已安装 wrangler，核对版本、Cloudflare 连通性和账号，再执行登记。`$WRANGLER_BIN` 指向核验通过的可执行文件。不要反复用 `npx` 拉新版本或靠升级重试；同一路径最多重试一次，再试一种合理的替代，仍失败就保留 SQL 和产物并报告阻塞。

```sh
node scripts/feedback-catalog.mjs dist/data.js "$BATCH/feedback-catalog.sql"
"$WRANGLER_BIN" --version
"$WRANGLER_BIN" whoami
"$WRANGLER_BIN" d1 execute agenthub-feedback --remote --config feedback/wrangler.jsonc --file "$BATCH/feedback-catalog.sql"
```

只登记已审核的公开稿，沿用 `INSERT OR IGNORE` 和现有的 D1 数据库。不重建表或库，不部署没有改动的 Worker，不升级付费套餐。生产环境的验证默认只用 GET，不运行会真实写票的测试。

### 提交与部署

提交前 fetch 并比较 `HEAD...origin/main`。只 stage 本期授权的读者文件、头像、`data/semantic-vectors.json` 和必要的代码或文档，排除 scratch、原始聊天、模型响应、私有审计和无关的用户改动。推送到 `main` 会触发 newspaper 仓库的 GitHub Actions 构建并部署到 GitHub Pages。非快进时先查远端变化，不 force-push。PR 合并需要另外的明确授权。内容没有变化且已成功发布时，不制造空提交，也不重复写库。

等待这次提交 SHA 对应的 Pages 部署成功，不把其他运行的成功当成本轮成功。然后运行 skill 自带的只读核验器：

```sh
node "$SKILL_DIR/scripts/verify-publication.mjs" \
  --newspaper "$NEWSPAPER" --site "$SITE" --date "$D" --out "$BATCH/publication-check.json"
```

核验器的行为：

- 从线上首页解析实际的 `data.js` 引用，要求线上数据与本地 `dist/data.js` 字节相同，目标刊期存在。
- 按索引里的版本号读取线上 `issues/D.js`，要求与 `dist/issues/D.js` 字节相同，并把该期正文合进输出的数据文件 `publication-check.json.data.json`。
- 读取 `$NEWSPAPER/lib/groups.mjs` 的 `pageGroups(D)`，要求这些群加外部资讯的版面都存在（允许诚实的空稿），每个群都有当日日榜。历史刊期因此自动按当时的覆盖检查。
- 最新刊期的社区榜截止日默认为 `D`。历史修订和补报必须传 `--rank-through`，值取应保留的线上社区榜截止日，不能为了通过检查随意指定。
- 输出文件必须不存在；重试时用新文件名，保留之前的证据。失败时核对 SHA、缓存版本和访问状态，最多间隔一段时间重试一次，不跳过一致性要求。

核验器只回读内容，不代替浏览器渲染检查和事实审核。之后用浏览器检查目标日期的全部版面（历史刊期按当时的覆盖）和 week / month / all 榜单：手机和桌面上直接打开、刷新、图片、无溢出、主题和反馈计数，查看实际截图。至少核对本期日榜和社区榜的窗口与纳入群。HTTP 200、核验器成功或 Actions 成功，单独都不能证明整期正确。

## 7. 导览文案与交付

导览文案是发到群里的一条合并消息，不留空行：首行之后紧接第一个版面；每个版面的正文和链接各占一行，链接后紧接下一个版面。草稿、发布版文案和交付的 Markdown 都遵守这个格式。

站点地址是 `$SITE`，每次使用前核对。正式页面路径是 `daily/D/group-N/` 和 `daily/D/external/`，榜单是 `rank/week/`、`rank/month/`、`rank/all/`，页内定位用 `#topic-N`。旧的 `#digest/...`、`#rank/...` 链接保持兼容。每期发布后核验对应的真实路径；仅在本地可用的链接不能称为已发布链接。

未发布时，基于审核稿准备待发布文案，注明链接待线上核验，不写“已更新”。发布后，用核验器回读的数据文件给模型提供刊期、各版报头、副题、稿件标题和真实链接，不提供正文。默认生成一条合并导览消息：每个版面一两句主线加链接，是总览，不复述稿件内容，不附活跃榜链接。只有用户明确要求时才另产分群版本。

```sh
node "$BOT/scripts/generate-bot.mjs" "$BATCH/publication-check.json.data.json" "$D" "$BATCH/published-bot.md" [--notes "$BATCH/bot-notes.md"]
node "$BOT/scripts/generate-bot.mjs" "$BATCH/final-reader-issue.json" "$D" "$BATCH/bot-preview.md" --preview
```

prompt 是 `$BOT/prompts/daily-bot.md`，脚本校验首行、Markdown 符号和链接集合。输出旁的 `.response.json`、`.run.json` 留在批次目录；复核后的正文复制到 `$REPORTS`。只有模型容易写错的具体事实（例如“某产品是计划发售，还没上市”）才写进 `--notes` 文件，不改通用 prompt。不要把“不能写成已证实”“尚非裁决”这类口径写进 notes，模型会把它们照搬成免责句。

- 写明刊期，不用营销套话或 Markdown 强调符号。
- 链接只指向本期实际有稿的版面。无稿的版面在合并导览里直接略去，不说明缺稿，也不填造看点或改指其他群的链接。用户要求的分群文案遇到本群无稿时，只说明缺稿，可附当天实际有稿的资讯和榜单。
- “假期愉快”等只在真实节日或用户要求时使用。
- 看点不超出审核稿或已核验的线上内容。不声称实验风险已被证实，不把理论或官方声明写成实际收益。
- 模型响应、实际模型和停止原因留在本机。主 agent 复核最终文案，不换成自己写的稿却仍署模型生成。
- 默认只保存草稿，不发送。

草稿保存为 `$REPORTS/D-AgentHub导览草稿.md`，报告为 `$REPORTS/D-AgentHub日报.md`。最终交付报告、预览和草稿的链接、各模块状态、来源缺口、榜单截止日期，以及授权和发布状态。未执行的线上检查不能写成完成。

发布后更新日报、资讯报告和导览文案的状态、链接和提交 SHA，不残留“未入库”“未上线”。保留真实的来源缺口，不把原先没做的调研写成已补齐。最后简短列出日报、资讯、榜单、文案和验证结果，写明未发群。交付末尾用一句话报出资料库和黑话落后几天（今天减去 `data/library.json`、`data/glossary.json` 的 `through`）；它们随周报补齐，日报不更新，也不追问。

## 8. 续跑与完成记录

在 `$BATCH/workflow.json` 维护一份轻量的私有记录，不另造一套内容 schema，也不覆盖已有的 `manifest.json`。记录 `date`、`timezone`、`windowStart`、`cutoff`、`mode`（preview 或 publish）、本轮授权原话、两个仓库的 base SHA、群稿和资讯目录、实际模型、当前阶段和阻塞原因。路径宜写成相对批次目录的路径；证据已在其他文件里的只存指针。

每个阶段的状态是 pending、running、done 或 blocked。done 必须引用真实的文件、检查结果或部署 SHA。这份记录不授权任何操作；续跑时重新核对用户最新的请求、文件是否变化和关键证据。

| 阶段 | 完成依据 |
|---|---|
| collect | 当天采集的每个群的输入、条数、分页尾页和覆盖窗口；外部各类来源的状态记录 |
| editorial | 最终群稿和资讯、模型响应、来源核验、隐私审核、与 revision 对应的锐评和重点 |
| activity | 本期各群日榜；最新刊期的同期社区榜，或历史修订 / 补报保留的较新社区榜；历史不变的校验；新头像已逐张审阅且无 pending |
| preview | 合并数据与审核稿一致；多视口、真实路径、图片和长图验收 |
| publish | 仅 publish 模式：正式入库、公开构建和测试、反馈目录登记、提交 SHA、对应部署成功 |
| live | 仅 publish 模式：线上回读数据、核验凭证、目标日期的浏览器检查结果 |
| delivery | 报告、资讯覆盖记录、一条合并导览草稿（分群版只在用户要求时）、正确的发布状态、未发群 |

改正文或标题会使对应的锐评、重点、revision、预览和后续的发布检查失效。改来源或 URL 至少要重审该条并重做预览。改头像或榜单要重做对应的一致性和视觉检查。不要删除其他已通过的采集证据，也不要用旧的审核凭证批准新内容。脚本退出码成功不能代替上表的内容条件。
