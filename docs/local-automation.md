# Windows 常驻采集

先按[快速上手](../README.zh-CN.md#快速上手)验证本机服务。服务进程可在 Obsidian 关闭时继续轮询已启用来源。重新打开插件并启用自动同步后，才会读取账本中已有的材料。关机、休眠以及上游可见窗口之外的历史可能形成缺口。

希望随 Windows 登录启动时，可以配置任务计划程序：执行 npm run build:server，把 Node 的绝对路径作为程序，dist/server/main.mjs 的绝对路径作为参数，项目目录作为起始位置，触发器选用户登录。保持监听 127.0.0.1。同一 SOURCE_DATA_DIR 同一时刻只由一个服务写入。先手动运行任务，在插件中检查连接和信源回执。

需要 B 站 RSSHub 时参照 [RSSHub 接入](rsshub-runtime.md)。更换版本或恢复数据见[运维说明](operator-runbook.md)。
