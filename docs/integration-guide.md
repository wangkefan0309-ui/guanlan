# 本地材料服务接入


status版本来自进程实际加载的package信息，插件版本另从当前安装读取。`GET /v1/runtime/identity`要求Bearer，返回固定instance、version、pid及stopEnabled，不读取业务账本；用于自有进程在账本异常时正常停止，采集健康和正文成功另核对。云端运行服务方案见部署与快照，尚未上线。已启用的[历史后台快照云备份](backup-retention.md)是维护者 CLI，不增加 HTTP 路由，也不把私有备份仓库作为插件更新地址；下游继续使用原材料后台、Bearer 和同步检查点。

## Claudian 本地接续验证

本地入口为`SourceWorkbench.verifyClaudian(): Promise<string>`，由“连接与设置 → Claudian 接续 → 验证 Claudian 接续”触发。成功返回已保存的验证说明并刷新接续入口；失败拒绝Promise，界面显示原因且允许重试。`claudianReason`为空表示当前接续接口可用，`claudianStatus`提供人可读状态；二者均不代表模型或知识加工成功。

回执位于实际`vault.configDir/plugins/source-workbench/claudian-compatibility.json`，结构为`{adapter:1,version,verifiedAt}`。Claudian版本或适配契约不匹配需重新验证，缺失或损坏时不放行未知版本。回执不属于HTTP材料、订阅或feed，不从服务端推送；不要手改版本或复制测试回执代替当前安装的验证。方法/草稿结构检查、按需准备空白页及保存顺序见[架构](architecture.md#claudian-本地接口验证)，日常操作见[知识接续](knowledge-integration.md)。

## 历史精选的本地接口

`ReadingLibrary.historyHighlights(options)`返回`{date, days, remainingCount, rotatedCount}`。调用会在北京时间当日尚无非空清单时保存首次引用，因此不能用作只读健康检查。`options`包含可选的`maxItems`（1～5，默认2）、`excludedUrls`和`sources`；`sources`使用`UpdateSource[]`，不是HTTP订阅配置。插件设置字段为`historyMaxItems`，需显式保存。

`ReadingLibrary.historyUrls(date?)`只读取该日引用在当前活动材料中的URL，日期省略时为北京时间当日。新探索先预留历史清单，再按规范化URL排除；已有当天探索URL也从新历史候选中排除。历史数量独立于探索上限，旧探索批次不重新筛选。

数据位于阅读目录`_工作台/state.json`的`historyDays`，每项为`{date, createdAt, maxItems, picks:[{id, version, reason}]}`，旧索引缺字段默认空数组。清单引用原版本，不复制正文；保存失败不计入曝光，空池不提交日期。恢复需同组材料和索引，切换目录不迁移清单。具体操作、冷却与故障边界见[历史精选](history-highlights.md)。

## 探索检索与页面证据

历史精选在插件本地处理，不增加HTTP路由、服务环境变量或feed字段。订阅补收负责取得遗漏内容，历史精选只引用当前阅读库中已经保存的材料，二者范围不同。外部接入仍先通过既有导入/feed保存材料，后续在工作台打开“历史精选”。

公开技术检索对多板块中文清单采用按天轮换的单方向词，回执保留实际query和改写说明。候选契约可带`origin: subscription`，仅表示插件从当前阅读库实际保存的近期未读正文补充；仍进入同一评分日批次。没有新增删除共享材料的HTTP路由，本地回收站由ReadingLibrary管理。

探索卡片已读使用本地`ReadingLibrary.updateManyProgress(ids, 'done'): Promise<number>`，按规范化链接匹配活动材料并保留各版本位置；不新增HTTP阅读状态接口。目标库在操作开始时捕获，未保存草稿先阻止修改，返回0表示原材料已不存在。外部推荐须先收录，回收站材料不提供快捷入口，推荐原回执不重写。

v0.17.0候选可包含可选 `linkedEvidence: {url, excerpt}`（摘选40～1600字符）。`/v1/exploration/evidence`对X帖文只补读实际contentLinks里的文章/项目，每帖一条、每批最多三条；保留原帖id/url/日期/excerpt/coverage和附件，外链独立存对应HTML原件与编号证据，不读取视频内容或扩展X线程。补读失败只加覆盖说明。原帖只有元数据但外链补读成功时可进入模型评价，不能把外链文字当作视频文字稿。

`POST /v1/exploration/search`同样需要Bearer，严格输入`{provider:"public"|"tavily",queries:["1～2个检索方向"],key?:""}`；每项2～240字符。public固定HN/GitHub，Tavily缺Key报错，固定basic/auto_parameters=false、最多两次请求。返回`{candidates,warnings,snapshots,credits,modelUsage?,xUsage?,freeXUsage?}`；共享结果契约至多24候选、14份有界原件，public/Tavily自身仍至多十二候选。搜索Key不写回响应或原件，接口不改变订阅配置/材料账本。

`POST /v1/exploration/evidence`严格输入`{candidates:[...探索候选契约]}`，最多24项、跨实际query轮流读取至多六个公网实页；返回同一结果契约，其中credits=0，无模型调用。保留HTML原件、内容摘选/真实元数据日期；实际页面中的节目链接可增加候选，并用`evidenceUrl`记录讨论出处，不把节目介绍当转写。未取得原页时保留原覆盖与警告，DNS私网、非标准端口和逐跳重定向受原网页抓取保护。探索模式使用已有代理时仍固定公网目标IP。

DeepSeek原生联网不通过`/search`：插件直接请求官方`https://api.deepseek.com/anthropic/v1/messages`，tool=`web_search_20250305`、max_uses=3，再向本机`/evidence`发候选做免费网页核对。现有模型Key只发官方模型端点，不发材料服务。超时/部分工具失败保留已知回执，未知结果不自动续发。详见[探索模块](active-exploration.md)。

`GET /v1/exploration/x/status`需要Bearer，无外部请求，返回`{month,limitUsd:0.5,spentUsd,reservedUsd,availableUsd,requestsToday,paused,reason}`。

`POST /v1/exploration/x/search`需要Bearer，严格输入`{key:"本机SocialData Key",topics:["domestic","international","business","investing","finance","life","growth","technology"]}`；Key非空、最多8192字符，topics为1～8个不同的有效枚举。返回同一搜索结果契约，至多9个X候选和3份原API JSON回执；可选engagement为`{likes,reposts,replies,views?,observedAt}`，xUsage含本批返回数/费用、全局月额度、未知预留和缓存标记。X Key仅传当前已配置材料服务及固定SocialData端点，不入账本；模型Key仍只发模型端点。账本跨阅读目录/Key共享；每天至多三次Top首页、未知暂停当月、不自动翻页。实际价格/供应商页大小边界见[费用](source-options.md#x)。

本机后台管理独立27187，GET `/status`和POST `/check`、`/stop`使用另一份控制令牌，见 [本机说明](local-automation.md)。网络类失败按1～15分钟退避；授权、限流及写入错误分别处理，完整规则见下文订阅回执。

## 地址与鉴权

默认地址为 `http://127.0.0.1:27183`。所有接口都需要 `Authorization: Bearer <令牌>`，POST 使用 `Content-Type: application/json`。默认令牌在 `.local/server/token.txt`；配置 `SOURCE_DATA_DIR` 或 `SOURCE_TOKEN` 时按 [运维说明](operator-runbook.md) 取值。令牌与模型 API Key 分别配置。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| GET `/v1/runtime/identity` | 无请求体 | `{ instance:"source-workbench-material-runtime", version, pid, stopEnabled }`，独立于账本加载 |
| POST `/v1/runtime/stop` | `{}`，同一服务Bearer | CLI实例202接受正常关闭，等待采集回执落盘再释放锁；无关闭回调的嵌入实例404 |
| GET `/v1/status` | 无请求体 | `version`、`mode: local-import/local-subscriptions`、`subscriptions: not-configured/configured`、`enabled`、`running`、`errors`；configured 表示至少一项启用，并非实采成功 |
| POST `/v1/import` | 下表的格式字段与内容 | `{ material: ... }`；材料已经写入服务端账本，尚需插件保存进 Vault |
| POST `/v1/transcript` | `{ url, topic? }`，YouTube或B站BV第一分P | `{ material }`；保留原字幕及缺口，客户端保存，服务feed不变 |
| GET `/v1/feed` | `after` 为非负整数；`instance` 为上次服务实例标识 | `instance`、`cursor`、`items`、`hasMore` |
| GET `/v1/subscriptions` | 无请求体 | 配置 `revision`、`running` 和 1～100 个来源的配置/回执 |
| POST `/v1/subscriptions` | `{ revision, sources: [全部完整配置], categories?: [...], collectionScope?: "today"或"feed-window", catchupDays?: 0～7整数 }` | 保存后的配置及回执；过期 revision 拒绝保存；省略补收窗口保留当前值 |
| POST `/v1/subscriptions/poll` | `{}` 或 `{recoverNetwork:true}` | `{}` 显式强制检查；恢复模式只提前处理至少一分钟前失败的网络来源，其他来源遵守原到期时间。立即返回当前配置/回执，采集异步进行；不表示采集已经完成 |
| GET `/v1/youtube/access` | 无请求体，同一Bearer | `{revision,configured,verifiedAt,requestsToday,dailyLimit,paused,lastError}`，不返回密钥，不请求Google |
| POST `/v1/youtube/access` | `{revision,key}`或`{revision,clear:true}`，严格二选一 | 验证成功才保存，或显式清除；返回同一状态视图，失败保留旧配置，完整约束见[官方接口](youtube-official-api.md) |
| POST `/v1/sources/resolve` | `{ input: "公众号或其他RSS/Atom、博主主页" }` | `{ platform, name, accountId?, feedUrl }`；只识别，不创建订阅 |
| POST `/v1/exploration/search` | `{ provider, queries, key? }`，详见检索说明 | 搜索候选、警告及原件；不写材料账本 |
| POST `/v1/exploration/evidence` | `{ candidates: [...] }` | 有限实页证据及实际节目链接，无模型调用 |
| GET `/v1/exploration/x/free/status` | 无请求体 | `{ provider, configured, verified, date, requestsToday, returnedPosts, paused, reason }`，仅本地状态 |
| POST `/v1/exploration/x/free/login` | `{}` | `{ opened: true }`，仅窗口已启动，不等于登录成功 |
| POST `/v1/exploration/x/free/search` | `{ topics: [...] }`，八板块枚举 | 搜索结果及可选freeXUsage，同日缓存，全实例共享 |
| POST `/v1/exploration/x/free/post` | `{ url, topic? }`，已采集公开帖文 | `{ material }`，仅缓存提取，不写订阅feed |
| GET `/v1/exploration/x/status` | 无请求体，暂停的付费备选 | 本地SocialData月额度/预留状态，无外部请求 |
| POST `/v1/exploration/x/search` | `{ key, topics }`，显式选择付费才调用 | 候选及xUsage；当前未真实付费验收 |

## 订阅配置与回执

v0.16.0内部持久化publicationAttempts，在原文I/O前保存尝试并按次数公平重试，避免失败/未知日期永远占满30项。写回仍核对当时配置与策略，保存失败不确认seen。daily.eligible包含尚未完成核验的RSS候选，不能当作已确认作者当天数量；首页数量以已保存且核验日期的材料计算。

新服务默认 `collectionScope: today`、`catchupDays: 0`；旧状态缺scope按 `feed-window` 兼容。v0.19.2可明确开启前1～7天补收，窗口与 `collectionStartedAt` 共同限定原发布日期，旧配置不自动扩展采集范围。视图在窗口大于0时返回 `catchupDays`，来源本轮实际补收大于0时返回 `catchupImported`（包含在imported内）；0时省略以兼容旧插件顶层严格解析。日计数仍区分当天、旧、未知、未来，补收旧文不会计为当天。公众号候选即使RSS有全文也核对原页面账号/日期/正文，日期失败不回退抓取日，失败不确认seen。跨日和每六小时完整核对均不带条件缓存；其他请求保留正常ETag效率。修改补收窗口与修改scope一样取消旧策略在途任务。同步游标、已有正文和原件保留，日期页按原作者日期归档。

配置字段为 `id`（WX-/YT-/BL-/RSS- 加 UUID，兼容旧三位数字）、`platform`（wechat/youtube/bilibili/rss，旧配置默认 wechat）、可选 `name`、`accountId`、`enabled`、`feedUrl`、`topic`、`intervalMinutes`（15～1440）和 `summaryIsBody`。1～100 项，id 唯一且前缀须匹配平台。YouTube 必填 UC 开头的稳定频道 ID；B站必填数字 UID。开启需更新地址和板块。YouTube配置仍保存规范官方频道Atom地址，验证保存Key后采集器优先官方Data API，失败才使用Atom/公开主页；B站支持对应 UID 的官方空间 URL 或 RSS。`summaryIsBody: true` 只用于操作者已核对上游将正文放入摘要字段的情形；工作台常规设置保持 false。

v0.18.0：保存 `enabled:false` 后，自动检查和手动强制检查都跳过该来源，并中止该来源的在途读取；其他来源继续。先持久化配置再取消请求，写入失败不改变原订阅。晚到的旧结果不会入账，即使随后快速重新开启。已经进入保存步骤的材料先完成，成功关闭不删除历史材料、原件或seen指纹。重新开启按当前日期策略和去重规则处理；启用catchupDays后可补当前有界窗口内的遗漏，不补全停订期间全部历史。来源页开关会先读当前revision，只改指定来源的enabled；过期弹窗仍拒绝覆盖新配置。

GET 返回的每个 source 包含 `config`、`name`、`status`、`lastAttempt`、`lastSuccess`、`nextDue`、`error`、`imported` 和 `pending`。status 为 not-configured/paused/waiting/running/ok/error。imported 是最近这一轮实际新增的材料版本数，pending 包含本轮失败项和分批剩余项；lastSuccess 只在当前页完整处理后更新。失败时旧的 lastSuccess 可能仍保留，需同时检查 status/error。

v0.22.5可选返回`recentChecks`（最多12项）和独立保留的`lastFailure`。每项包含`checkedAt`、`status`、`message`以及失败时的`kind`，类型为network/authorization/rate-limit/verification/content/storage/unknown。成功不会删除最近失败记录；来源身份更换会清理旧来源历史。历史中的URL与凭据隐藏，不保存密钥或完整响应。旧回执缺少历史时不虚构过去的故障。

网络、连接中断、超时与上游HTTP408/5xx按1、2、5、10、15分钟重试，重启时也将旧网络长退避收敛至15分钟。分类先检查限流、授权与写入错误，混合备用路线报错不会因含有“网络”字样而绕过429/412或授权等待。其他暂时内容/验证错误仍最多60分钟，其他失败最多1440分钟。恢复模式与定时任务合并，不中止已有采集，不重发模型。

可选 `collectionMethod: feed/direct-api/browser/public-page` 表示最近取得的列表方式；旧客户端与旧状态可省略。YouTube官方API成功标为direct-api，公开主页备用标为public-page；仍须同时检查本轮status/error/lastAttempt，保留的方式不代表本轮成功。配置SOURCE_CHROME_PATH时，B站订阅失败或身份校验不符可通过本机Chrome直连公开页补抓；原JSON与派生XML分别保存，五分钟成功窗口复用，未配置Chrome不冒充启用。

`POST /v1/subscriptions/poll`输入`{}`或`{recoverNetwork:false}`会显式跳过到期等待；`{recoverNetwork:true}`仍检查已到期来源，仅对至少一分钟前失败的网络来源提前检查，不提前处理未到期的健康、授权或限流来源。两种模式均遵循条目去重和条件请求。重复启动检查共用运行中的任务，轮询 GET 查询真实结果，再通过 `/v1/feed` 保存进阅读库。正文成功持久化后才确认条目；失败或积压时不提交 ETag/Last-Modified。网络与保存恢复机制见 [架构](architecture.md)。

feed和原页GET遇可识别网络瞬断时最多额外尝试一次；授权、限流和明确错号本身不触发即时重读。`nextDue`只是计划时间，单轮顺序采集和在途请求可能延后实际执行；不能把一分钟重试计划解释为一分钟内保证恢复。客户端同时显示本轮status/error及lastAttempt，不能用旧lastSuccess或HTTP200代替正文成功。

微信已有空正文容器可回退`content_noencode`，输出仍用现有coverage/gaps表示部分正文或公开付费预览。核验失败原页和识别摘要保存在后台私有`subscription-snapshots/<SHA-256>.html`、`<SHA-256>-<sourceId>.json`，不作为成功材料进入feed；识别摘要含capturedAt、sourceId、url、expected、identified、coverage、publishedAt。账号、作者日期、补收范围和保存保护均保留，失败页仅供有权限的本机排障。

XML 更新链接支持 RSS 2.0/Atom，4 MB/200 条以内；B站官方空间 URL 由固定 API 读取最近十条投稿，再转换为 RSS 解析并保存原 JSON。每轮每账号处理最多 30 个改变条目，剩余分轮继续。XML 原件保存到服务端 subscription-snapshots，HTML 字段原件随 material 分发。订阅摘要不冒充正文，必要时请求公众号原文并核对账号。上游请使用公众号原文链接，关闭本地缓存文章链接。

## 识别来源与管理分类

`POST /v1/sources/resolve` 使用相同 Bearer 鉴权，输入 `{ "input": "公众号或其他RSS/Atom、博主主页" }`。返回 `{ platform, name, accountId?, feedUrl }`；只识别，不修改订阅、不新增材料。条目全部为微信原文链接时识别为wechat，其他RSS/Atom和暂时空feed识别为rss；公众号后续仍核验原页面账号与日期。YouTube 主页取频道自身元数据并用公开 Atom 复核，B站主页取 UID；B站识别成功不代表匿名投稿 API 可用。

普通RSS支持博客、新闻等提供的RSS 2.0/Atom；保留feed正文字段HTML原件，没有正文或只有截断摘要时读取公开原网页，不套用公众号身份检查。仍区分提取覆盖缺口，不提供网页列表自动订阅或任意平台自动适配。rss与wechat按同一规范化feed地址跨类型判重。本机端口仍受已有feed传输地址规则约束；网页正文抓取保持仅公网限制。

支持 YouTube /channel/UC…、@handle、/c/及/user/主页；不能把单条视频当作频道。YouTube watch 与 Shorts 条目统一用 video ID 去重，仍校验频道和作者。识别超时 35 秒；不执行来源内容中的命令。

v0.16.2：官方频道RSS读取失败后，可以使用同频道的公开主页备用检查。`collectionMethod`新增`public-page`，消费者必须接受该值；Videos/Shorts/Streams各自有限首页窗口，不表示全历史覆盖。页面与视频身份、精确发布日期必须核验；明显旧日期仅用于排除历史视频，不补造发布时间。原始页面JSON与生成XML分别保存；两路均失败保留原lastSuccess与材料。新增来源识别也支持该回退，客户端仍使用同一官方feedUrl和频道ID。

`GET /v1/subscriptions` 返回 `categories: [{ id, name, topic }]`。`POST /v1/subscriptions` 可提交同名字段，与 sources 在同一 revision 下原子保存；旧客户端省略 categories 会保留现有分类。无分类字段的旧状态补充当前八类默认值，已保存的旧六类配置继续兼容。自建分类 ID 为 cat-UUID，名称 1～60 字且不能重复；默认类保留 ID/阅读方向，可改显示名称。删除仍被来源引用的分类返回 400。

来源配置新增可选 `categoryId`、`accountName`（实际账号名称，与显示 name 分开）。新来源 ID 支持平台前缀加 UUID，兼容旧三位编号。公众号按规范化 feed 地址、视频按频道 ID/UID 判重；分类移动保留已有采集指纹。保存失败不改变后台配置，revision 冲突需重新打开。

材料可附带 `sourceId/categoryId/categoryName`。工作台按来源当前分类展示旧材料；这些分类字段不改变内容版本。手动导入仍使用固定 topic，不接受任意服务配置字段。

## RSSHub 接口与 B站配置

当前影视飓风配置 platform=bilibili、accountId=946974、feedUrl=`http://127.0.0.1:1200/bilibili/user/video/946974/noembed`。HTTP 客户端先读取全部配置，替换指定来源的 feedUrl，再以当前 revision 保存全部 sources/categories；不省略其他来源。根 channel link 必须对应 UID，条目为 B站视频链接。RSSHub XML 复用现有采集、快照、去重和 `/v1/feed`，视频 coverage=metadata。

v0.5.1 插件从现有正确 RSSHub 路由继承服务 origin，为新 UP 替换 UID；来源识别 API 的返回仍是规范主页。没有匹配服务时保留直接 API，多个 RSSHub origin 提示先统一。明确保存的字面回环订阅允许采集端端口，普通网页导入仍不能访问本机。

RSSHub 1200 是独立进程：GET `/_workbench/rsshub` 查询身份与版本，POST `/_workbench/rsshub/stop` 正常退出，两者用 `.local/rsshub/control-token.txt` 的 Bearer，未授权 401。它们不是材料服务 `/v1/*` 路由；普通 RSS 路由在本机公开可读。具体启动和环境约定见 [RSSHub 运行说明](rsshub-runtime.md)。

## 导入请求

`POST /v1/import` 导入一份材料，成功返回 `{ material: Material }` 并先写入后台材料账本；不创建订阅。插件入口为“藏卷 → 添加材料 → 添加链接”或命令“导入阅读链接”，普通文章请求示例为 `{ "format": "url", "url": "https://rikiyat.github.io/blog/weight-space-programming/", "topic": "ai-learning" }`。该请求会实际登记材料，开发复验须使用独立服务；若只检查提取结果，应直接调用 `fetchPublicHtml` 与 `extractHtml`，不调用本路由。

| format | 必需字段 | content 的编码 |
| --- | --- | --- |
| `url` | `url` | 不提供；服务请求公开网页并提取正文 |
| `html` | `content` | HTML 字符串 |
| `pdf` | `content` | 原 PDF 的 Base64 |
| `markdown` | `title`、`content` | Markdown 字符串 |

`format=url` 只读取公网、标准 HTTP/HTTPS 端口返回的 HTML，最多三次重定向、12 MB、每次请求25秒读取超时；不执行页面脚本。PDF 文件链接会提示使用文件导入。微信正文按专用区域/内嵌内容字段提取，普通页面使用 Readability 后经 Turndown 转为 Markdown；服务不调用模型或 MinerU。返回原 HTML，正文按 `partial`、无可用正文按 `metadata` 表达覆盖。正文中的图片仅保留远程 HTTP/HTTPS 绝对地址，相对地址被移除，未实现图片下载与完整离线存档。

可选字段为 `url`、`title`、`source`、`identity`、`topic`；请求拒绝未定义字段。`topic` 默认为 `ai-learning`，还可选择 `ai-news`、`finance`、`law`、`headlines`、`leisure`（娱乐与生活）、`cognition`（认知）、`opinion`（观点）。文件名不代替学习板块判断。

同一份手动材料更新时复用 `identity`，正文或原件变化由版本哈希区分。默认手动身份为 `local:markdown:<标题>`、`local:pdf:<标题>` 或 `local:html:<传入标题或提取标题>`；同名不同材料填写不同标识。网页默认使用规范化 URL。版本与旧文件迁移规则见 [架构](architecture.md)。

在项目目录的 PowerShell 中，启动服务后可用以下示例导入一份 Markdown。示例假定默认数据目录且没有设置 `SOURCE_TOKEN`：

```powershell
$sourceWorkbenchUrl = 'http://127.0.0.1:27183'
$sourceWorkbenchToken = (Get-Content -LiteralPath '.local/server/token.txt' -Raw).Trim()
$sourceWorkbenchHeaders = @{ Authorization = "Bearer $sourceWorkbenchToken" }
Invoke-RestMethod -Uri "$sourceWorkbenchUrl/v1/status" -Headers $sourceWorkbenchHeaders

$sourceWorkbenchBody = @{
    format = 'markdown'
    title = '概念试读'
    identity = 'local:markdown:概念试读'
    topic = 'finance'
    content = '这份手动材料用于阅读测试，事实仍需核对。'
} | ConvertTo-Json
Invoke-RestMethod -Uri "$sourceWorkbenchUrl/v1/import" -Method Post `
    -Headers $sourceWorkbenchHeaders -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($sourceWorkbenchBody))
```

HTTP 客户端导入后，在工作台点击“同步已采集材料”。插件弹窗导入网页、HTML、PDF 时会直接保存服务返回的材料，无需再手动同步；插件内 Markdown 导入直接保存到 Vault，不进入服务账本。以上“概念试读”示例仅在27183独立测试实例使用；正式库共享后台的账本会分发给各客户端，开发样本使用隔离服务及validation用途，不向27186写入合成阅读材料。

插件中的“导入并交给 Claudian”和“导入并直接写入 Wiki”都先完成上述材料保存，随后接续指定版本；普通导入只保存材料。直达选择不是 `/v1/import` 的参数，也没有新增 HTTP Wiki 写入端点。知识加工仍由 Claudian 在同一 Vault 按正式协议执行，客户端不能以导入 HTTP200 标记 RAW 已登记或 Wiki 已归纳。操作及目录关系见[知识接续](knowledge-integration.md)。

## 增量同步

首次请求为 `/v1/feed?after=0`。读取一页、把该页所有材料可靠保存到目标库后，再保存响应的 `instance` 和 `cursor`；`hasMore` 为 true 时继续请求下一页。服务实例不同会从头返回，插件通过材料版本去重。不要只保存游标而跳过材料。

服务每页最多 20 项，通常以 24 MB 为批次边界；首个大材料可以独占一页并超过该边界。插件一次同步最多处理 100 页，达到上限可再次同步。一次任务固定使用发起时的目录及服务配置。

已有材料的正文批注保留并记录冲突，允许后续独立材料继续保存。原件缺失、校验失败、未登记文件冲突或实际写入失败阻止游标推进。直接重导入被批注的正文仍报告冲突。


## 材料与错误语义

`material` 包括身份、标题、来源、可选 URL/发布时间、采集时间、板块、类型、用途、正文、覆盖缺口、导读身份与可选原件。完整契约以 [model.ts](../src/core/model.ts) 为准。

| 字段 | 含义 |
| --- | --- |
| `coverage: full` | 已取得投放的正文文本，仍需核验内容事实 |
| `coverage: partial` | 已提取部分范围，例如网页文本或 PDF 文本层 |
| `coverage: metadata` | 没有可用正文；打开来源或补充原件，不生成全文解释 |
| `guideKind` | `excerpt` 为摘录提示，`ai` 为 AI 导读，`none` 为无导读；当前提取服务不调用导读模型 |
| `purpose: validation` | 技术验证材料，排除于今日推荐与实际板块覆盖 |
| `original` | `extension` 与 Base64 原件；PDF 保留页码，扫描页明确提示缺口 |

成功为 HTTP 200。令牌不符为 401；路由或方法不匹配为 404；参数、提取与保存异常通常为 400，响应是 `{ error: "..." }`。客户端应展示失败原因并保留同步检查点，不把收到 HTTP 响应当作保存成功。

限制包括请求 40 MB、PDF 25 MB/300 页、正文 150 万字符、标题 240 字符、来源 160 字符。网页抓取只访问公开地址；验证页可能作为仅元数据材料保存。完整恢复步骤见 [运维说明](operator-runbook.md)。

## 文字稿端点

`POST /v1/transcript`，需要材料Bearer，严格请求`{url:"https://www.youtube.com/watch?v=...",topic:"ai-learning"}`，topic可省略。仅支持标准HTTPS YouTube视频和B站BV第一分P；平台及字幕地址分别校验，公网DNS固定和逐跳检查沿用原抓取保护。

成功返回`{material:Material}`，kind为markdown、coverage为partial，body带时间段，original为平台字幕JSON对象（extension=json），gaps标明语言、自动字幕、空段、总时长及画面缺口。原件扩展名契约新增srt/vtt/json；原HTML/PDF/Markdown契约继续兼容。

不写订阅账本或feed；插件把明确选入的结果保存到捕获的ReadingLibrary。没有字幕、身份不符、需登录或格式不合格时返回HTTP400和原因。2026-10-12的YouTube真实请求受登录/反机器人限制，B站分支没有真实字幕成功回执，语音转写未配置。当前材料后台已包含此端点，鉴权、失败及feed不变见v0.13.1验收。文件路线及恢复见[知识接续](knowledge-integration.md)。

## 免费X端点

同样需要材料服务Bearer令牌；X账号凭据只在本机配置，不由HTTP请求提交。

当前默认免费路线，SocialData因最低充值门槛暂停。状态中的configured只表示有登录配置，verified表示已有成功实采证据；requestsToday是应用级首页检查数，非SDK初始化/重试在内的全部HTTP数量。状态字段与严格输入见[free-x-contract.ts](../src/core/free-x-contract.ts)。

- `GET /v1/exploration/x/free/status`：提供方、登录配置/实采状态、北京时间日期、本日请求与返回数量、暂停原因。查看状态不搜索。
- `POST /v1/exploration/x/free/login`：请求体`{}`，打开专用窗口让用户登录；返回`{ "opened": true }`只表示窗口已启动。
- `POST /v1/exploration/x/free/search`：请求体`{ "topics": ["technology", "growth"] }`，严格拒绝多余凭据字段。返回既有搜索结构及可选`freeXUsage`，无付费`xUsage`。

- `POST /v1/exploration/x/free/post`：严格输入`{ "url": "https://x.com/作者/status/帖子ID", "topic": "finance" }`，topic为既有阅读主题、默认ai-learning；返回`{ material }`。核验公开帖文URL、作者及已保存原件摘要，只从缓存提取完整帖文、保存原始对象的Markdown容器。返回coverage=full仅指本条文字，不含视频转写、外链正文或回复；不发外部搜索，不写服务订阅账本/游标，客户端通过ReadingLibrary保存。未找到或原件损坏返回400，绝不抓登录页。

候选可选`media={kind:"video",durationSeconds?}`及至多四项`contentLinks=[{url,label,kind:"article"|"video"}]`，只来自真实原件；缺时长不编造，旧回执兼容。免费search在插件允许205秒等待三个有界子进程，超时保留未知状态，不自动重发。

缓存收录示例沿用上文$sourceWorkbenchUrl/$sourceWorkbenchHeaders，但当前实例应改为27186及其数据目录令牌。将示例URL替换为本实例**已采集**的帖文；以下只提取缓存，不搜索或调用模型：

```powershell
$sourceXBody = @{ url = 'https://x.com/作者/status/帖子ID'; topic = 'finance' } | ConvertTo-Json
$sourceXResult = Invoke-RestMethod -Uri "$sourceWorkbenchUrl/v1/exploration/x/free/post" -Method Post `
    -Headers $sourceWorkbenchHeaders -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($sourceXBody))
```

客户端解析返回material后保存目标阅读库；此请求不会进入/v1/feed，因此不能仅等待普通同步。topic省略默认ai-learning，接受上述八个阅读主题。未采集、作者不符、危险URL或原件损坏为400；未授权401。现有X候选被裁剪出九条精选仍可从全部已保存帖文中收录；新回执postIds只加速查找，不补抓。XURL的插件手动导入也使用此端点，弹窗前捕获目标目录/连接。

`freeXUsage`记录twscrape、返回帖数、请求次数、缓存及暂停，不标记付费费用。每日最多三个Top首页，单页最多20条，不翻页；所有目录共享首次结果与主题。缺配置不占日批次；尝试后失败/超时/中断暂停当天，次日可检查。回执先保存并校验再回放；保存失败只重试原响应保存。原SocialData端点保留，仅明确选择付费时使用。见[使用与恢复](free-x-setup.md)。
