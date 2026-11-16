# 安装新版与本机签名更新

从 GitHub Releases 下载对应版本 ZIP，备份 Vault 和插件目录。关闭插件，更新 source-workbench 目录中的四个程序文件，再重新启用。保留插件 data.json、阅读目录和后台数据。更新后台之前另行按[运维说明](operator-runbook.md)备份数据；插件和后台各自核对版本。

插件内也保留本机签名更新协议。它只从 loopback 上已配置的材料后台读取签名和程序文件，检查版本、文件名、长度和哈希。安装前检查运行中任务或未保存草稿，事务失败时从备份恢复。签名私钥由通道维护者单独保存。GitHub Releases 不会给本机旧签名通道自动推送。

实现见 [核心校验](../src/core/plugin-update.ts)、[安装事务](../src/plugin/plugin-update-files.ts)和[后台更新通道](../src/server/plugin-updates.ts)。仓库保留第三方版权说明。
