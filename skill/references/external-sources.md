# 外部资讯补查与选题

`$BOT/scripts/collect-external.mjs` 只抓了一层基础候选（AIHOT Top 10、HF 当日论文、alphaXiv 热门、HN Top 60、X 高互动 40 条）。做完整日报或周报时，还要按下面这张表把其他入口扫一遍，点开原文核实后才能定稿。

| 来源 | 怎么查、注意什么 |
|---|---|
| AIHOT | 除了热榜，还要翻最新流 `/api/v1/items?mode=all&window=7d&by=published&limit=100`，顺着 `page.nextCursor` 往回翻到目标日之前。注意 AIHOT 上的 `publishedAt` 往往是入库或转载时间，要顺着里面的原始链接点回首发页面看真时间。 |
| X | 搜当天大事件关键词和主要实验室、作者的官方号，按原帖的 `created_at` 折算成北京时间核对。 |
| Hugging Face | 看 Daily Papers 和官方 Blog / 社区文章。周末空榜时看最近一个有内容的日期，但别把前几天的老论文硬改写成今天刚发的。 |
| Hacker News / YC | 扫 Top、New、Show HN，再单独看一眼 YC 官方新发的文章。注意 HN（`news.ycombinator.com`）和 YC 聚合页是同一拨来源，别当成两家独立佐证。 |
| 一手技术博客 | 顺手扫一圈常出干货的源（见下方 RSS 列表），挑当天有实质内容的更新。 |

## 常查的一手博客与订阅源

- Google Research：`https://research.google/blog/rss/`
- vLLM：`https://vllm.ai/blog/rss.xml`
- Simon Willison：`https://simonwillison.net/atom/everything/`
- Latent Space：`https://www.latent.space/feed`
- PyTorch：`https://pytorch.org/blog/feed/`
- BAIR：`https://bair.berkeley.edu/blog/feed.xml`
- Sebastian Raschka：`https://magazine.sebastianraschka.com/feed`
- Anthropic Engineering：`https://www.anthropic.com/engineering`
- arXiv cs.AI：`https://rss.arxiv.org/rss/cs.AI`（周末常为空，用论文的 `/abs/` 页核对版本与日期）

## 选题与核实规则

- 入选的每条新闻都要点开一手原文（或官方发布材料）读过，不能光凭热榜标题或二道贩子的两句摘要就写。
- 厂商自己发的性能跑分、降本比例写明是“官方公布”或“官方测试”，别写成已经过第三方独立复现；预告、内测、逐步放量和正式上线要分清楚。
- 同一件事（比如某模型发布同时带了博客、权重和几个子功能）合写成一条，附上 1 到 3 个最核心的链接，别拆成三四条占版面。
- 日报 schema 里标为 `kind: "paper"` 的“双榜推荐”论文，需要同时在当天 HF 和 alphaXiv 进前五（填真实 `paperRanks`）；如果是某团队当天新发的技术报告或开源工作、不在双榜前五里，按普通 `kind: "news"` 写即可，别编排名。
- 每天选几条看当天真有多少值得看的事（schema 允许 1 到 8 条），不硬凑满 8 条，也别扫完前三篇就收工。如果所有渠道都翻过了、当天确实一条合格的都没有，就留空版（构建会显示“本日外部资讯尚未收录”），不要拿旧闻充数。
