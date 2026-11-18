# 安装与更新观澜

社区目录上架后，在 Obsidian 的第三方插件页面搜索 **Guanlan**，安装并启用。日后在同一页面检查并安装更新。

从 GitHub 手动安装时，在当前 Vault 的插件配置目录下创建或复用 `source-workbench`，复制 Release 的 `main.js`、`manifest.json` 和 `styles.css`。替换已有安装前先保存草稿并禁用插件；完成后重新启用。保留原有 `data.json` 与阅读目录。文件夹名仍为 `source-workbench`，因此从早期手装版本升级时无需新建插件实例或迁移阅读资料。如果旧版签名更新中断，先在旧版完成恢复再更换程序。

材料服务是可选的独立进程。更换插件不会升级服务和服务账本；服务的升级与备份见[运维说明](operator-runbook.md)。社区版通过 Obsidian 分发，没有旧手装版本中的内置更新器。

维护者可在干净检出运行 `npm ci`、`npm run verify` 和 `npm run package:community`。后者把三项附件放到 `release/community/<版本>/`，SHA-256 清单在同级目录。GitHub 正式 Release 标签必须与 `manifest.json` 的三段版本一致。将这三份文件分别上传为附件；可另提供手动安装 ZIP。首次上架走 [Obsidian Community Directory](https://community.obsidian.md)，通过后由目录跟踪 GitHub Releases。
