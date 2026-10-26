# 周报流程

## 产品与范围

周报的内容版面是每个纳入的群各一版，加一版外部资讯，另附该刊期各群独立的周榜。周报与日报共用常规的报纸视觉、匿名规则、模型写稿和事实审核流程。

群的覆盖按 `$NEWSPAPER/lib/groups.mjs` 的 `from` 和 `pageFrom` 确定。一周跨越某个群的版面起始日时，该群只统计已核验且属于本刊期的留存记录，并注明覆盖起点；不补造起始日之前的稿件、零消息记录或榜单。版面数、榜单栏目数和分群导览数量随该刊期的实际覆盖确定。

周报回答“这一周发生了什么变化、有哪些值得复用的经验和未决问题”。按主题跨天合并，保留时间推进和群别。不要拼接七份日报，也不用周日的日报标题冒充周报标题。

周报不沿用日报的小条数习惯。每群可以有 12 条甚至更多，由独立的信息量决定，12 不是配额或上限。首轮选题后补查遗漏的实质讨论、无人回应的公开资料和工程问题。不为凑数拆开同一个话题，也不把无关的资料过度压成一条。同一分享者的关联个人工具仍然合并，跨群的同一话题只保留各群新增的证据和视角。

## 1. 固定时间与批次

先读 `$BOT/scripts/README.md`、`$NEWSPAPER/docs/publishing.md` 和日报[操作手册](runbook.md)的第 1 节。本文件定义周报流程，仓库的数据安全要求继续适用。

- 默认是上一个完整的自然周：北京时间周一 00:00 到下周一 00:00，不含右端。周日执行也不包括尚未结束的本周。
- 显式范围优先。不是周一到周日的范围称为“区间回顾”，不称自然周。
- 周报刊期固定显示为周一到周日，每周一发布上一个完整自然周的周报。只覆盖到周六或有缺日时，必须显示为“区间回顾”或明确披露缺口，不能只把结束日期顺延到周日冒充完整周报。
- “本周截至现在”是阶段稿。续跑时锁定原始的起止时间，不随当前日期漂移。
- 例子：2026-09-29 执行“上周周报”，刊期是 09-21 到 09-27，截止时刻是 09-28 00:00（北京时间）。09-28 日报里的内容不能混入这一期。

可以用无副作用的日期工具算出窗口：

```sh
node "$SKILL_DIR/scripts/weekly-window.mjs"
node "$SKILL_DIR/scripts/weekly-window.mjs" --from 2026-09-21 --through 2026-09-27
```

这个工具只输出边界，不创建报告，不采集也不发布。批次放在 `$NEWSPAPER/scratch/weekly-FROM_THROUGH-runN/`，本文件下面的 `$BATCH` 指这个目录。`workflow.json` 记录 `kind: weekly`、时间窗口、mode、授权、各阶段状态和证据，不覆盖日报批次。默认 mode 是 `preview`。

## 2. 群聊材料与完整性

已审核的日报可以作为选题索引和来源线索，但核验讨论过程要用原始的逐日输入。定位已有的私有日批次，确认账号、群、日期、截止时刻、分页读尽和整日记录都匹配。复用合格的输入，补采缺失的群日，不因为某天没有已发布的日报就跳过它。不重新生成已审核的日报，不写正式的 `data/editions/`。

`$PIPELINE/collect-batch.mjs FROM THROUGH $BATCH` 可以串行采集各群的逐日输入。已核验的输入不重复采集。缺日时按 `$PIPELINE/collect-daily.mjs` 的当前接口（`DAILY_OUTPUT_DIR` 指定输出目录）把缺日补进独立目录，再整合，不猜参数。实时阶段稿先核查采集脚本是否支持准确的截止时刻；不支持时不能伪装成日终完成。

为“七天 × 本刊期纳入的群”建立私有覆盖表。群在版面起始日之前的群日单独标注为未纳入。分清三种情况：

- 本次本地筛选的分页已读尽，结果为零；
- 本机历史没有覆盖；
- 查询失败、截断或分页没有读完。

这三种情况都不能单凭查询结果写成“当天无人发言”。分页读尽不证明本机保存了全部历史。对已读取的原文，按现行的 ID 规则去重；同一成员跨日的归并只在私有证据里做。完整周报遇到历史缺档时，仍可以交付明确限定覆盖范围的选编，但采集失败不能称为全量完成。

## 3. 模型周度编辑

先建立主题证据表，再让模型写稿。各群在原始读取完成后可以并行生成，外部资讯独立并行；不并发读取同一账号的数据库。

模型做主题发现时，输入必须是整个刊期的原始可读记录（保留日期和私有的消息定位），不能用已有的日报或周报正文代替。长输入按日期或讨论片段分块时，先覆盖全部原文再跨块合并；写稿时携带所选主题的原始消息，而不只是上一轮的摘要。保存实际输入和来源凭证。续修周报的关联关系时同样回到原文，不只润色旧稿。

每个主题保存群别、涉及的日期、原始消息依据、公开资源、已有日报线索和取舍理由。按语义合并同一件事；关键词相同但问题不同的不能硬合并。各群独立成版，共享的事件宜在一个版面详写，其他版面只写各自独有的观点，不重复全文。

每群可以有多个并列主题，数量由原文里独立议题的数量和信息量决定，不限定为“一群一个主题”或固定三条主线。整期周报和每个群版面都要有具体的编辑标题；群别、刊期和刊名另作标识，不能用“一群·一周讨论”代替标题。标题提炼主要看点，副题可以并列补充其他议题。跨日主线只是其中一层：能串联的讨论展示时间发展，单日但重要的独立话题、资料和短讯仍然单独保留，不为主题统一而删掉。

对证据充分的主题提炼“本周主线”：起点、按日期排列的新增信息或尝试、意见的变化、截至周末的未决问题，并链接详细讨论。区分“跨日延续”（同一问题或项目的后续）和“相关议题”（编辑把独立讨论联系起来）；后者不得写成回应、因果或已经解决前文的问题。每个节点必须有该日期的原文依据，只有同一天的材料不能制造跨日发展。读者能看到主题和日期，消息 ID 只留在私有审核里。版面顶部提供并列主题的入口和完整的讨论目录，读者不必读完主线才能找到其他话题。

给模型的写作要求：

- 版头概括该群一周的具体议题。主要话题交代起点、进展、尝试结果、分歧和未决问题。
- 正文可以引用代表性发言，用“提问者”“使用者”“另一位群友”等匿名角色；分清精确引语和转述。只有回复元数据能建立直接回复关系。原始讨论节选按第 6 节放该话题的关键发言，通常 20 到 40 条。
- 比较前后进展需要两个时点的原话。“本周共识”“大家认为”需要证据。活动预告不等于活动已完成。
- 公开的论文、项目、数据集等实质分享逐项核查，不因无人回应而漏选。重复分享合并，条数取决于信息量。
- 独立的 AI 锐评针对具体内容，不补入新事实。结论和标题不比正文更强。
- 文字用社区编辑的口吻写具体的事，避免“讨论重心逐步聚焦”“形成闭环”这类汇报套话，不把审核过程写进正文。主线导语只交代背景，日期节点写新增信息，结尾不再复述全部节点。必要的未验证条件自然地写在对应事实旁边。模型润色后仍逐项检查日期和观点归属，不把“本周分享”改成“本周发布”，不恢复已删除的私人细节。

模型调用用 bot-workflow 仓库的 `$BOT/scripts/generate-weekly-gemini.mjs` 或 `$BOT/scripts/call-llm.mjs`，读取 `$BOT/lib/llm.mjs` 的模型、端点和输出上限。不复制旧批次里写死模型或端点的脚本。当前周报生成器不启用推理；更换模型时，应核对推理与正文如何共享输出预算。

输入过长时按主题分片，再整合，保留全部分片的处理记录。审核时检查模型是否把无关话题并成一条，并拆开独立主题。日期范围、主题和证据用私有的审核格式；交付网页只投影读者字段，不暴露消息 ID、姓名、群 ID 和审计信息。

## 4. 一周外部资讯

外部资讯是与各群总结并列的独立版块。日报有当天的资讯，周报另有周度资讯入口；资讯不塞进各群的讨论或主线，也不靠拼接七篇日报形成。

用[资讯补查](external-sources.md)覆盖整个刊期，不只扫执行当天的热榜。已审核的日报资讯可以复用原始证据，但仍要检查这一周有没有后续、重复报道和漏项。按 AIHOT 最新流、X 原发布者、HF 论文和博客、HN Top / New / Show、YC 原创和补充原站回查。

周度的重点是发布和后续变化。按事件归并，不把一个产品的功能拆成多条。临近午夜或只有日期的重大候选先回官方原文，不因聚合站的转载时间直接排除。无法确定属于哪一周时标注时间不确定；用户明确要求加入时，独立标注“截稿后补充”，不改变主刊期的边界。

论文和产品 / 工程资讯同属外部版。论文按本周实际发布和研究价值选题，不强制日报那样的 HF / alphaXiv 前五交集，不凑固定数量。当前热度只是采集时的快照，不能还原历史排名。日报的 `externalWindow` 只接受单日，`validateSelection` 的 paper 模式有双榜限制，不要直接用这套 schema 装周报，也不要用假日期绕过。

## 5. 周榜

周榜必须对应 FROM 到 THROUGH 的同一窗口。不能把当前的 `/rank/week/` 当作历史周榜，也不能把七天的 Top 3 相加当作周榜。复用原始的去重记录和 `$NEWSPAPER/lib/activity.mjs` 的 `summarize(rows, start, end)`、计分和并列规则。先核对各群每天的原始条数，再分别筛选各群的整周记录，各自生成 Top 3，不能用社区合并榜代替。周榜页按本刊期纳入的群分栏，保留并列名次。同一人在多个群的消息分别计入对应的群。

窗口和群都完全相同的已审核快照可以复用；否则用已核验的原始记录，或当前采集模块的只读数据库路径和私有身份映射，重算这一周。新增头像逐张查看。公开数据只投影名次和审核过的头像，不给姓名、分数、身份键或规则。头像接口返回“暂时无法查看”一类的占位图时视为缺失：保留名次，显示“头像暂不可用”，不能当真实头像用，也不能拿别人的头像替补。

周榜是周报自己的快照：不改当前的社区周 / 月 / 总榜，不回退最新日报的榜单截止日，不调用日报的 `publish-reviewed-batch.mjs`。有群日缺档时，明确写出榜单只覆盖本机留存的记录。查询失败或头像审核未完成时，把周榜标为未完成，不编补。

## 6. 可复用执行链

每次周报都按同一个批次目录执行：先锁定窗口和实际的群覆盖，再生成内容。不要把上一次的 HTML 或日报正文当作本次输入。下面的 `$GROUPS` 是本刊期纳入的群 id，用逗号分隔，例如 `group-1,group-2,group-3,group-4,group-5`；`FROM`、`THROUGH` 换成实际日期。

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-batch.mjs" FROM THROUGH "$BATCH"
node "$BOT/scripts/generate-weekly-gemini.mjs" FROM THROUGH "$BATCH" "$BATCH/weekly-pages" --groups "$GROUPS"
node "$BOT/scripts/generate-weekly-emphasis.mjs" "$BATCH/weekly-pages"
# 审核并组装出 reader/reader.json 之后，补全每个话题的原始讨论：
node "$BOT/scripts/weekly-discussion-evidence.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence"
node "$BOT/scripts/weekly-attach-discussions.mjs" "$BATCH/reader/reader.json" "$BATCH" "$BATCH/evidence" "$BATCH/discussion-audit.json"
node "$BOT/scripts/weekly-select-discussion.mjs" "$BATCH/reader/reader.json" "$BATCH/select" \
  --audit "$BATCH/discussion-audit.json"
node scripts/import-reviewed-weekly.mjs "$BATCH/reader"
WEEKLY_SOURCE_DIR="$BATCH/weekly-pages" \
WEEKLY_OUT_DIR="$NEWSPAPER/data/weekly-editions" \
WEEKLY_ISSUE_ID=FROM_THROUGH \
WEEKLY_GROUPS="$GROUPS" \
node scripts/import-weekly-stage.mjs
npm run build    # 第 8 节的资料库与黑话增量合并之后再构建，作为同一次预览
node "$BOT/scripts/generate-weekly-bot.mjs" data/weekly-editions/FROM_THROUGH.json \
  "$REPORTS/FROM_THROUGH-AgentHub周报导览草稿.md" \
  --split-dir "$REPORTS/FROM_THROUGH-bot"
```

原始讨论节选只放关键发言，分两步做：

1. 先收全。`weekly-discussion-evidence.mjs` 让模型按话题自己的日期读原始消息，返回该话题的全部相关消息 ref，不设上限（每批最多 4 个话题，消息多的日子按 1200 条分段读，续跑时复用已完成的批次）。`weekly-attach-discussions.mjs` 补上同一天对这些消息的引用回复，按话题给发言者编号，把所有群里出现过的昵称换成“群友 N”（成员会跨群互相称呼，只换本群昵称会漏）。
2. 再挑主干。`weekly-select-discussion.mjs` 保留提问、观点、回答、反驳、关键补充和分享的结果；引用回复与被引用的那条成对保留；去掉附和、表情、复读和跑题。每个话题通常保留 20 到 40 条。已经在上限内的话题不送模型；超长的可以用 `--max` 再收一轮。最后用规则再删一遍漏网的纯表情和“是的”“+1”。

`weekly-attach-discussions.mjs` 的输入应来自同一群日的一对 `input.json` / `raw.json`。脚本核对时间、类型和去敏后的正文，并在内存中规范化来源编号，不修改原始文件。缺少可靠的跨日身份依据时，不把不同日期的局部化名当作同一人。

已审核的隐私删除项可在 attach 时用 `--exclusions "$BATCH/discussion-exclusions.json"` 传入。清单格式如下，两数组均可省略。

```json
{
  "exclude": [{ "group": "group-1", "ref": "YYYY-MM-DD:m0001" }],
  "removeQuote": [{ "group": "group-1", "ref": "YYYY-MM-DD:m0002" }]
}
```

`exclude` 剔除整条消息，并阻止引用补齐把消息重新加回。能够解析为指向该消息的引用文本也会移除。`removeQuote` 只去掉指定消息的引用块。不要先手改读者文本再靠重跑 attach 保留删除。

筛选时始终传 `--audit "$BATCH/discussion-audit.json"`。脚本同步读者条目和私有审计，保留已有发言者编号；引用目标删除后不凭文本猜发言者。未传审计时会提示，并把引用发言者置空。读者文本、顺序与审计不一致时会拒绝，需从证据重新组装或同步审核过的删选，不能只手改其中一边。

完成后扫一遍原始昵称，确认没有漏网。消息 ref 和身份只留在 `discussion-audit.json`。不要在节选面板里加“完整讨论见日报”的链接。

先收全再挑主干，是为了让编辑能对照完整候选选择关键回合。只挑少量代表发言可能漏掉问题与回应；直接展示全部消息又会带入附和、复读和跑题。跨日话题应检查各天的进展，把无关的讨论拆开，不只靠删短消息缩短篇幅。

周报的每个页面内嵌整期数据，页面体积随各版讨论的总量增长。

历史刊期按当时的采集覆盖传入实际的群列表，`--groups` 和 `WEEKLY_GROUPS` 用同一组值。外部资讯、周榜和导览文案是独立的阶段，不能因为内容页生成成功就认为它们也完成了。生成器会保存每群实际的 prompt、模型返回值和运行元数据；输出前仍要做隐私、日期、链接、独立主题和移动端页面检查。

## 7. 网页、文案与发布边界

默认交付同一份周报的全部版面、独立周榜、本地 HTML 预览、分享图片和模型写的导览文案；历史刊期按原有覆盖。沿用当前的报头、分栏、字号和常规主题，日期显示整周。原始输入和审核证据留在 scratch。最终报告和文案放在 `$REPORTS/FROM_THROUGH-AgentHub周报.md` 和 `$REPORTS/FROM_THROUGH-AgentHub周报导览草稿.md`。

每个群、外部资讯和周榜各占一个独立页面，沿用日报的顶部版面切换，不把这些页面拼成长页。独立页面用实际的站点路径，页内话题才用 hash。每页显示当前版面的状态。验证直接打开、刷新、前进后退和页内定位。

扩版靠目录和内容层级解决阅读密度：每群有可跳转的主题目录，重点讨论保留完整背景和对话，独立的短讯和资料用更紧凑的分栏，移动端按顺序单栏。目录顺序与正文一致。主题入口保持紧凑，完整目录可以展开，不让两套长目录占满首屏。分享图片按版面分成可读的多页，标明是导览还是全文；不能靠缩小字号塞进一张超长图，也不能让图片省略的信息从 HTML 和 Markdown 里丢失。正文、主线和时间线不重复堆叠同一个结论。

导览文案默认只有一条可直接发送的全刊消息，按实际覆盖的群和外部资讯的顺序概括，每个版面选 2 个看点，外部资讯和周榜使用该周的真实入口；不拆成分群版本。预览阶段的正式地址只是计划，不声称已上线。没有真实的周报 URL 时，交付待填链接的文案或本地产物链接，不能用日报地址代替周报地址。

站点的周报发布链路：审核后的读者数据用 newspaper 仓库的 `scripts/import-reviewed-weekly.mjs` 入库为 `data/weekly-editions/FROM_THROUGH.json`；构建时 `lib/weekly-render.mjs` 生成静态页 `/weekly/FROM/THROUGH/<group-N | external | rank>/`，页内嵌入本期数据。版式与日报一致（同一刊头、导航、明暗模式），原始讨论用与日报相同的浮窗（`site/discussion-panel.js`）。

周报上线需要用户对本期明确授权。沿用上面的链路，不借用日报的单日 ID 或核验器伪装周报。链路不能满足本期需要时，保留全部本地产物并说明准确的阻塞，不声称已发布，也不让用户重新授权同一项发布任务。普通的“改工作流”请求不授权上线或修改定时任务。

验收全部版面和周榜在 320、390、820、1440 宽度下的文字溢出、图片、实际 PNG 和跨版导航（`VERIFY_SITE=… node test/weekly-browser.mjs` 覆盖亮暗两色、讨论浮窗和两种导出图）。历史刊期核对实际的版面数量。公开构建与本地审核稿一致；确认日报和日报的榜单没有变化，原始证据没有进入构建。发布沿用现有的 GitHub Pages，遵守当前权限，不新建站点。新的赞踩标识需要独立的刊期身份并登记，不能挂到同名日报的票数上。

## 8. 资料库、机会与黑话增量

资料库（`data/library.json`）、机会（`data/opportunities.json`，群里发过的招聘、活动和征稿）和群聊黑话（`data/glossary.json`）每周随周报补齐一次，与周报一起预览、一起发布。日报不更新它们。范围是从各自 `through` 的次日到本期周报的结束日；三者的截止日可能不同，分别计算。`through` 已经不早于结束日时，跳过该项并在交付中说明。

收集脚本读 `$NEWSPAPER/scratch/` 下的逐日群聊输入（`<日期>/<group-N>.input.json`）。日报和本周报的采集已经生成了这些文件，不需要重新采集。先核对范围内每一天、每个已覆盖的群都有输入；缺日时按第 2 节补采，不能用缺日的结果推进 `through`。资料库按 `$NEWSPAPER/docs/publishing.md` 的“资料库、机会和黑话”一节执行：

```sh
WX_ACTIVITY_HOME="$WX_HOME" node "$PIPELINE/collect-library-candidates.mjs" --since <library 的 through 次日>
# 按 docs/review/library.md 审核，写 scratch/library/curated/*.json
node scripts/check-library-review.mjs
node scripts/assemble-library.mjs          # 逐张查看新头像后写 avatar-review.json，再运行一次
node "$PIPELINE/collect-opportunity-candidates.mjs" --since <opportunities 的 through 次日>   # 在资料库审核之后运行，会带上被资料库排除为推广的活动和招聘卡片
# 按 docs/review/opportunities.md 审核，写 scratch/opportunities/reviewed.json
node scripts/assemble-opportunities.mjs
node "$PIPELINE/collect-glossary-chunks.mjs" --since <glossary 的 through 次日>
# 按 docs/review/glossary.md 审核，合并进 data/glossary.json 并更新它的 through
```

审核可以与周报的周度编辑并行。资料库一周约 15 到 20 条，可以交给一个 subagent 按 `docs/review/library.md` 初审；主 agent 合并结果，核对简介里的数字和说法，并亲自查看每张新头像。黑话要通读本周的聊天，找出新出现的缩写、代号和别称，按 `docs/review/glossary.md` 核对证据。周报正文已读过的分享和讨论可以作为线索，但资料库的收录以候选清单为准，不只收周报写到的条目。机会一周通常只有几条，由主 agent 自己审：打开原文和官网核对日期、地点和链接；招聘都收；任何邮箱、手机号、微信号和发帖人都不写进条目。

另看一次站内搜索的查询记录：`node scripts/search-stats.mjs` 报告里“站内没有的词”和零结果的查询，挑出确有其意的说法，补进黑话词典或 `data/search-synonyms.json`（同义词只收可互换的写法，规则见 `$NEWSPAPER/docs/search.md` 的“维护词表”）。查询原文不进入任何产物。

预览：增量与周报用同一次本地构建，运行 `npm test`、`node test/build.mjs`，以及非公开构建之后的 `node test/library-browser.mjs`。交付时列出新增和更新的资料条目数、新增的机会（其中仍开放的条数）、新词条，以及被拒的头像数。机会的开放状态按构建当天计算，所以即使某周没有新机会，周报发布那次构建也会把过期的条目移到“已截止”。

发布属于周报发布授权的一部分。公开构建之后依次完成：

```sh
node scripts/feedback-catalog.mjs dist/data.js "$BATCH/feedback-catalog.sql"   # 登记新资料的点心计数，同时登记周报
"$WRANGLER_BIN" d1 execute agenthub-feedback --remote --config feedback/wrangler.jsonc --file "$BATCH/feedback-catalog.sql"
node scripts/embed-catalog.mjs                                                  # 新周报话题、资料和黑话的语义向量
```

然后把 `data/library.json`、`data/library-avatars/` 的新增文件、`data/opportunities.json`、`data/glossary.json`、`data/semantic-vectors.json` 与周报文件一起提交推送。线上核验时确认 `/library/` 显示新的收录截止日，抽查一条新资料的 `/content/item?id=library:<id>`，并确认 `/content/search` 返回的 `query.semantic` 为 `used`。

## 完成记录

阶段依次是采集覆盖、周度编辑、外部资讯、周榜、资料库与黑话增量、预览、发布、线上核验、交付。每个完成状态附上实际的产物或验证结果。只改工作流时，用边界测试和离线情景演练验证，不为测试去读取群聊、调用付费模型或发布网站。

预览的终点是完整的本地产物和审阅过的导览文案。发布的终点还要有：准确提交 SHA 的部署成功、线上周报和周榜与本地一致、实际截图、基于线上内容重新生成的导览文案。日报、周报和历史补报的授权和批次互不借用，默认不发群。
