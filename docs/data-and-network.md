# Data, network access, and costs

Guanlan is free to use and does not include usage telemetry. Optional third-party services may require their own accounts, API keys, or subscriptions.

| Feature | Destination and data |
| --- | --- |
| Local reading, Markdown or SRT/VTT import, reading progress | Stays in the Vault. The file picker reads only what you select, including a file outside the Vault. |
| Subscriptions, links, HTML/PDF extraction, public video captions | The configured material service receives subscription addresses, links or selected file contents and a service token as applicable. It fetches configured feeds and public pages. Depending on your setup, this may involve an RSS provider, WeChat pages, YouTube and its Data API, Bilibili, or a separate RSSHub instance. A remote service operator can see the content you send. |
| AI guides and discovery | The configured model endpoint receives the request, relevant reading text or excerpts, and the configured preferences or queries. DeepSeek native search can use its official model endpoint. Other public search or Tavily goes through the configured material service. Optional X search or capture uses a separate configured X session or SocialData API through the service. Model usage, paid feeds and optional APIs may incur charges. |
| Knowledge handoff | Choose a specific item and task to send its saved material and context to Claudian. Further network use and model billing depend on Claudian's configuration. Checking Claudian compatibility does not send material or call a model. |
| Reading and opening originals | Opening a source link visits its website. Reading notes that contain external images can cause Obsidian to load those images from their original hosts. |

The service URL starts as localhost with an empty token. Remote service and model URLs require HTTPS. Automatic AI and discovery are off by default. The plugin stores configuration, including entered service tokens and API keys, in its Vault configuration. If you sync that folder, the configuration may be synced as well. When using the service, its storage (including subscription and captured material data) is separate from the Vault. Do not include token, API key, or account session files in a bug report.

## 中文

观澜本身免费，不包含使用行为统计。部分第三方服务可能要求各自的账号、密钥或订阅。

| 功能 | 数据与去向 |
| --- | --- |
| 本地阅读、Markdown 或 SRT/VTT 导入、进度保存 | 在库内保存。导入只读取你在文件选择器里选中的文件，可以来自库外。 |
| 订阅、网页、HTML/PDF 提取、公开视频字幕 | 按功能把订阅地址、链接或选中的文件内容连同服务令牌发给你配置的材料服务。后台按配置访问 RSS、微信、YouTube/官方 API、B 站或独立 RSSHub。部署在远程时，运行该服务的人能看到你发送的内容。 |
| AI 导读与兴趣发现 | 把相关正文或摘录、阅读偏好或检索词发送到你配置的模型接口。DeepSeek 原生联网使用其官方模型端点，公开检索或 Tavily 由材料服务调用。X 搜索及相关提取依赖材料服务配置的账号会话或 SocialData。模型、付费订阅源和可选接口可能产生费用。 |
| 知识接续 | 你选定材料和任务后，插件把所选材料和任务上下文交给 Claudian。后续联网与费用取决于 Claudian 配置。验证接续接口不发送材料，也不调用模型。 |
| 查看原文和远程图片 | 点击原文会访问对应网站；笔记含外部图片时，Obsidian 可能向原图网站请求图片。 |

材料服务默认地址是本机，令牌为空；远程服务和模型地址要求 HTTPS。自动 AI 和探索默认关闭。输入的令牌和密钥保存在库内插件配置中，如果同步这个配置目录，密钥也可能随之同步。独立材料服务有自己的数据目录。反馈问题时不要附带令牌、API Key 或账号会话文件。
