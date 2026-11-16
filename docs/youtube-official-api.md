# YouTube稳定连接与一次性密钥配置

v0.20.0已提供官方YouTube Data API接入。没有密钥时仍使用原来的RSS和公开主页，不会自动启用官方接口。配置后优先读取官方公开视频列表，失败再尝试RSS/公开主页；同一个频道、视频身份和发布日期校验继续执行。它解决对匿名播放器页面的依赖，不代表网络、密钥或平台服务永不失败，也不提供字幕、下载或已观看内容。

## 创建与填写

1. 用自己的Google账号打开[YouTube Data API配置页](https://console.cloud.google.com/apis/library/youtube.googleapis.com)，选择或新建一个项目。
2. 启用 **YouTube Data API v3**。
3. 在Google Cloud的“API和服务 → 凭据 → 创建凭据 → API密钥”创建Key，将其API限制选为 **YouTube Data API v3**。本机后台请求不用网站HTTP来源限制；配置了不适用的来源限制会验证失败。
4. 正式Obsidian打开“来源管理 → 管理订阅与分类 → YouTube稳定连接”，将Key粘贴进密码输入框，点击“验证并保存YouTube密钥”。真实官方频道验证成功才保存，失败保留旧配置。
5. 首次验证后可点击同窗口“立即检查更新”，等待来源回执，再“同步已采集材料”；日常使用来讯或信源的“检查并同步”。YouTube来源本轮走官方路线时，回执显示“YouTube官方接口”。

创建Key在Google Cloud进行，Google官方步骤见[入门说明](https://developers.google.com/youtube/data/getting-started#before-you-start)。Key直接填本地输入框；不在聊天里发送，也不复制到测试材料或公开仓库。“移除本地YouTube密钥”只清除该后台的凭据，来源、原材料和阅读进度保留。

## 失败时先看来源回执

网络连接失败、读取超时或临时服务错误会自动重试，单凭这些错误无需重新保存Key。信源可查看下次重试时间、最近检查记录和最近失败；浏览器能打开网页只证明浏览器该次访问成功。明确的密钥/启用状态/权限限制错误才检查配置，配额耗尽遵守暂停期限。正常重试与网络恢复均继续使用已经保存的Key，Google配置验证成功不代替全部频道本轮采集成功。

## 免费配额与估算

2026-10-19核对，[官方默认额度](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)对本轮使用的普通读取接口合计每天10,000单位；[channels.list](https://developers.google.com/youtube/data/reference/rest/v3/channels/list)与[playlistItems.list](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list)每次各1单位。此处是API配额单位，不是按视频时长计算。

按每个频道每小时检查一次、每天缓存一次频道信息、每次视频列表1～2页估算：

| 频道数 | 每日正常配额估算 | 默认额度占比 |
| --- | --- | --- |
| 4 | 约100～200单位 | 约1%～2% |
| 10 | 约250～500单位 | 约2.5%～5% |

这是正常检查的估算，失败重试、分页和手动验证会增加用量。当前规模可在默认免费额度内使用。程序另设每日1,000次本地读取请求上限，按YouTube配额日（美国太平洋时间）重置；计数在请求前保存。确认官方配额耗尽时本日暂停官方路线，不反复请求，继续尝试其他路线。成功验证新Key时计入1次，用户主动验证不受自动读取上限约束；本地计数不包含验证失败或同一Google项目被其他应用使用的额度，实际余量以Google控制台为准。

## 本机保存及HTTP契约

Key仅保存在已连接材料后台数据目录的私有 `youtube-access.json` 中，不回显到插件配置、GET状态、采集原件或错误输出。该文件属于私有完整备份，不能随公开安装包分发。换连接时，窗口始终捕获打开时的后台；密钥不自动复制到新连接。

- `GET /v1/youtube/access`：要求Bearer，返回revision、configured、verifiedAt、requestsToday、dailyLimit=1000、paused和lastError，不返回Key。
- `POST /v1/youtube/access`：`{revision,key}`验证后保存；`{revision,clear:true}`显式移除。过期revision拒绝覆盖。慢验证和在途读取不能跨越新的密钥配置，停服等待验证及保存结束。
- 官方主机固定为 `www.googleapis.com`，仅调用channels/playlistItems读取；复用已有来源代理，不跟随带凭据请求的重定向，不使用Google登录Cookie。
- 频道信息缓存24小时、成功列表缓存5分钟；每轮最多两页各50项。作者日期取 `contentDetails.videoPublishedAt`，不把条目加入列表时间当作视频发布日期。私有条目跳过，身份/日期缺失保留失败。完整JSON单独保存且移除凭据，不当作视频文字稿。

真实配置及启用与否见当前状态，开发、隔离验证与正式安装证据见v0.20.0验收。
