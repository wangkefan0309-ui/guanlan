# RSSHub 本机运行

2026-10-10 已按用户选择启用本机 RSSHub。影视飓风 `BL-001` 使用 `http://127.0.0.1:1200/bilibili/user/video/946974/noembed`，材料服务仍在 27186；完整回执见 v0.5.1 验收。这是免费自建软件，没有购买视频采集 API；本机资源及用户已有网络代理另算。

2026-10-11更新：当前RSSHub由 [本机后台](local-automation.md) 自动启动和恢复，登录启动项已装。正常停启整套后台用local:stop/start；单独维护RSSHub前先停后台，避免守护过程重新拉起。

## 启停与配置

本机已经配置并运行，无需重复 setup。在项目 PowerShell 中：

```powershell
npm run rsshub:status
npm run rsshub:start
npm run rsshub:stop
```

start 复用身份校验成功的已有实例，隐藏启动窗口；stop 通过本项目专属令牌请求正常退出，不按端口/PID 终止其他进程。仅绑定 127.0.0.1，无试验的十五分钟退出计时。当前已有本项目登录启动项；关机/休眠暂停，恢复后补检查，网络/代理未就绪保留失败并重试。

`.local/rsshub/config.json` 保存 port、upstream、node、chrome、commit、dependencyVersion 与可选 reuseHttpsProxy（默认 true）。控制令牌在 control-token.txt，运行回执在 runtime.json，日志为 stdout.log/stderr.log。全部在忽略目录，日志也按私密运行资料管理。该令牌与材料服务令牌不同。

wrapper 复用进程已有 HTTPS_PROXY/https_proxy，通过 RSSHub 的 PROXY_URI 配置代理，仅匹配 Bilibili/hdslb 域名；不改系统代理或浏览器个人资料，也不保存代理实际值。启动时读取本机 Chromium 的实际 UA 交给上游。2026-10-10 直连访客请求返回 412，已有代理下成功；遗漏代理或使用上游旧默认 UA 可再次失败。服务状态中的 existingHttpsProxy 只表示已配置，采集是否成功仍看真实回执。

wrapper 设 NODE_ENV=dev（执行固定原源码）、ENABLE_CLUSTER=0、CACHE_TYPE=memory、CACHE_EXPIRE=3600、REQUEST_RETRY=0、REQUEST_TIMEOUT=15000、CACHE_REQUEST_TIMEOUT=180、BILIBILI_EXCLUDE_SUBTITLES=1、CHROMIUM_EXECUTABLE_PATH。材料服务正常每小时检查，RSSHub 缓存默认一小时；刷新工作台不会强制绕过上游缓存。更改 wrapper/配置后用 stop/start 正常重载。

## 已验证的安装方式

本机无 Docker。本次采用原样固定源码 + 已安装 npm 生产依赖的兼容环境 + 本机 Chrome；不声称已经完成官方 pnpm 锁文件或 Docker 部署。

| 资产 | 实际位置/版本 |
| --- | --- |
| 官方源码 | `.local/bilibili-free/rsshub-test/upstream/`，提交 acdbec61c4977a7d9ab458c455365237e15e3d42 |
| 生产依赖 | 同级 runtime/node_modules，npm rsshub@1.0.0-master.5d857e3；upstream/node_modules 为 Junction |
| Node | 同级 node-runtime/node-v22.22.2-win-x64/node.exe，官方包 SHA-256 已核对 |
| Chrome | C:/Program Files/Google/Chrome/Application/chrome.exe；本次 154 系列 |
| 本项目 wrapper | scripts/rsshub-runtime.mjs，通过项目 tsx 和上游 tsconfig 执行 |

这些带 rsshub-test 名称的目录已成为当前运行依赖，不能作为临时缓存清理。新机器应先按上述固定提交准备源码、安装指定 npm 包及依赖、建立 Junction、放置对应 Node/Chrome，然后 `npm ci`、`npm run rsshub:setup`、`npm run rsshub:start`。setup 只校验并接管上述已准备的安装，不自动下载全部依赖；移机或采用官方 Docker 需单独验收。上游源码保持原样，RSSHub 为 AGPL-3.0，许可见 [原文](../THIRD_PARTY_NOTICES/RSSHub-AGPL-3.0.txt)。

## 新增 UP 主

v0.8.1材料服务增加免费Chrome公开投稿页直连回退，RSSHub失败时使用，与RSSHub的已有代理连接分开。后台从本配置提供SOURCE_CHROME_PATH，原订阅URL与第三方源码保留；成功窗口最多复用五分钟用于分批保存，实际方式见订阅回执，未配置Chrome不冒充启用。详见 本轮验收。

工作台“添加来源”粘贴 `https://space.bilibili.com/UID`，识别后选分类并添加。v0.5.1 从当前已保存 B站订阅继承同一个 RSSHub origin，生成 `/bilibili/user/video/UID/noembed`，无需手填 UID 或 RSSHub 地址。来源名称可修改；多个不同 RSSHub 服务并存时提示先统一配置。陌生 UP 的实际网络采集仍需看回执，界面识别不等于其视频已保存。

现有订阅的更新链接可在“来源订阅”中编辑。HTTP 客户端须自己保存 platform=bilibili、accountId=UID 及 RSSHub feedUrl；`/v1/sources/resolve` 仅返回规范 UP 主页，不替客户端选服务。首次返回最近窗口可能为 API 的 30 条或浏览器回退的 40 条，并非全历史；超出窗口的停机漏项未自动补齐。

## 管理接口、备份及故障

RSSHub wrapper 上的 GET `/_workbench/rsshub` 返回版本、端口、实例及配置标志；POST `/_workbench/rsshub/stop` 正常退出。两者要求本机 control-token.txt 的 Bearer，未授权返回 401；与 27186 的 `/v1/*` API 分开。普通 RSS 路由为本机可读的公开视频元数据。

备份 `.local/rsshub/`、上表固定运行资产及 material 服务数据；阅读目录和插件设置另按 [运维说明](operator-runbook.md) 备份。首次切换前的材料账本/订阅/令牌保存在 `.local/rsshub/pre-activation-backup/`，恢复这些历史备份会回退后续采集状态，须先停止相关写入。

| 现象 | 处理 |
| --- | --- |
| status 不可达 | 检查本项目实例、配置及日志；端口占用不关闭他人进程 |
| 503、412、等待视频列表超时 | 先确认已有代理运行，再核对 wrapper 的实际 UA；保留失败和原有材料，勿登记为空成功 |
| 更新停在旧缓存 | 一小时缓存与来源检查分开；先确认实际发布时间，必要时正常重启自有 RSSHub 重取，不能由重启推断新发文 |
| 材料服务失败但浏览器可取 | 分别检查 RSSHub 返回、根 UID、RSS 解析和保存；本项目 feed 超时 25 秒，慢冷启动可能待下一轮恢复 |
| 新 UP 没有文章/视频 | 查看该来源独立回执；仅一个 UP 的首轮成功不证明全部来源长期可靠 |

长时间增量、停机窗口、物理重启/休眠与云端资源仍须分别观察或验收；本次没有字幕、视频下载、模型或外部消息推送。
