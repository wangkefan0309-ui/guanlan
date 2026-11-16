# AIHOT 复用与个人版差异

2026-10-19按现有源码核对，当前实现范围见[实现范围](first-release.md)，版本与运行见项目状态。用户指定[AIHOT](https://github.com/KKKKhazix/AIHOT)机制作为参考，固定提交 `59c8c814aa0dfc49edcca9dbee003f2949172172`。`research/AIHOT-reference`保持原样；[MIT声明](../THIRD_PARTY_NOTICES/AIHOT-MIT.txt)随插件保留。固定版来源见源码核查。

## 已落地机制

| AIHOT参考 | 本项目实现 | 证据与差异 |
| --- | --- | --- |
| sources/rss.ts 的RSS/Atom、正文/摘要、条件请求 | src/server/rss.ts改造，feed-fetch.ts/subscriptions.ts承接请求/保存 | RSS是实际改造代码，文件头保留版权；真实订阅已接通 |
| 保存后提交游标，发现与内容成功分开 | 单写入者账本、逐项确认、快照及完整页后提交校验器 | 写入/回执失败、配置竞争、重启及积压分批通过；目录数量不代替正文 |
| 采集与读者界面分离 | 本机服务与/v1/feed，Obsidian独立阅读库 | 三平台实采、去重/进度、自动同步通过；未搬入上游数据库 |
| editorial/analyze.ts、prompts.ts、digest输入/回执身份 | 每日正文小批评价、编号原文证据、独立导读和用量、防重发 | 十二篇真实Flash为历史样本；最多12篇/前2400字符，专业长期质量待观察 |
| 宽预筛与按内容类型评价 | 兴趣评价PASS/BLOCK/UNKNOWN、程序算推荐价值，证据覆盖独立报告 | v0.17.0采用exploration-8；旧五轴回执兼容，不改历史评分；不是独立事实核验 |
| 同事件关系与证据追溯 | 同一具体事件/节目有限归组、合格原片优先、真实URL/原件/编号证据 | 预告与正式节目分开；四关系状态机、完整向量召回和发展图未移植 |
| 来源提供方及调度 | 取阅、YouTube官方Data API主路线与Atom/公开主页备用、RSSHub/Chrome回退；免费X另接twscrape | 官方API接入、YouTube备用检查与免费X为本项目适配；AIHOT没有B站专用更新链路，SocialData未真实付费跑通 |

固定订阅量小，按用户优先级和作者发布日期展示当天内容，历史按日期可查；不把模型评分/聚簇作为采集同步前提。兴趣搜索另接DeepSeek原生联网、免KeyHN/GitHub及可选Tavily；这些接入、个人化提示和Obsidian保存是本项目适配。

## 推荐价值与独立证据说明

v0.17.0将证据覆盖与推荐价值分开。新评价包含substance实质份量、novelty增量、relevance个人兴趣/起点、utility预期用途，各0～10整数。依据介绍推荐未读的文章、项目或视频时，basis=preview且substance=null；未知用途也用null，排除该轴后对其余权重归一化。实际取得内容的低份量继续触发淘汰，不能借null掩盖空泛内容。

| 类型 | 份量 / 增量 / 兴趣 / 用途权重 |
| --- | --- |
| news | 1 / 4 / 5 / 0 |
| opinion | 2 / 3 / 3 / 2 |
| learning、tool | 2 / 1 / 3 / 4 |

support单独标注firsthand原作者陈述、attributed转述或insufficient线索不足，不是事实核验结论。评分锚点6～7为明确值得打开，8～9为高度匹配且有具体增量/用途。一次小批合并预筛/评价/理由，程序重算0～100分，要求PASS且≥60、兴趣≥6、增量≥4或用途≥6；明确份量<4、线索不足、无实际入口及仅元数据不放行。没有启用AIHOT两次独立评分、全套来源tier或行业提示。旧exploration-1～7继续按旧字段展示，旧五轴公式仅用于兼容解析，不重算已保存记录。

exploration-8评价是否值得打开，按来源区分公告与已核验事实、计划与已发布，不要求已看完整片。X最多三条文章/项目外链补读，不观看视频、不伪造字幕。热度不自动加分，同事件去重不把独立教程/观点合并；结果和用量先保存，保存失败补首次响应，未知不重发，当天旧批次不因升级重新调用。详细流程见[主动发现](active-exploration.md)，旧质量证据见审查。

## 尚未移入的能力

PostgreSQL、pg-boss、全量向量召回、四关系事件图、独立热度检测、云端日报与外部通知未运行。正式RAW/Wiki接续及具体目标隔离晋升属于本项目另接的[知识流程](knowledge-integration.md)，已有独立验收；Claudian周期维护尚未启用。

## 2026-10-10 取阅购买前的公众号路线复核（历史）

固定AIHOT的mp_account走付费极致了Dajiala列表/详情，未使用本项目旧WeRSS扫码列表入口；本项目未配置或调用Dajiala。WeRSS五账号200013/自动正文0属于历史失败；30分钟退避不保证接口恢复，当前十公众号走已购买取阅全文RSS。历史核查保留在整理前复用快照及[WeRSS说明](werss-runtime.md)，不据此推断其他服务失效。

SocialData原适配器和月预算是暂停的付费备选，免费X已真实接入，模型仍按用量收费。平台及费用见[接法与费用](source-options.md)，探索质量证据见v0.12.0，当前完整检查见[实现范围](first-release.md)。
