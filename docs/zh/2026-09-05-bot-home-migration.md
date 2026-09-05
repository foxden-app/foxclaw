# Telegram 名称目录迁移验收

功能随 `0.7.3` 发布，预览版已安装到 16P 和 T490。本次迁移针对 T490 的 6 个多 bot runtime；16P 单 bot 兼容模式继续使用原默认 home。

T490 的实际运行目录如下。

| Telegram bot | CODEX_HOME |
| --- | --- |
| @WuguiAI_Bot | /home/wuya/.foxclaw/codex/telegram/@WuguiAI_Bot/home |
| @WuguiAI2_Bot | /home/wuya/.foxclaw/codex/telegram/@WuguiAI2_Bot/home |
| @WuguiAI3_Bot | /home/wuya/.foxclaw/codex/telegram/@WuguiAI3_Bot/home |
| @WuguiAI4_Bot | /home/wuya/.foxclaw/codex/telegram/@WuguiAI4_Bot/home |
| @WuguiAI5_Bot | /home/wuya/.foxclaw/codex/telegram/@WuguiAI5_Bot/home |
| @walma10bot | /home/wuya/.foxclaw/codex/telegram/@walma10bot/home |

`@WuguiAI_Bot/home` 链接到 `/home/wuya/.codex-gjzn`，保留原终端共享数据。其他 5 个 bot 的原数字目录已重命名，数字路径作为兼容链接保留。项目工作目录、数据库绑定、日志及运行状态 ID 没有改名。

迁移前确认桥内没有活动轮次、审批、输入请求或排队任务；逐个查询真实 app-server 的 `thread/loaded/list`，6 个服务均为空，然后停止桥。迁移程序逐文件计算 SHA-256，并比较目录/文件权限及符号链接目标。5 个独立目录分别校验 351、351、345、345、8420 个条目，合计 9812 个，迁移前后完全一致。共享 home 只验证链接与原目录解析到相同位置，没有搬移共享数据。

新版本启动后，status 中的 6 个 home 均为上述名称路径，6 个子进程的真实 `CODEX_HOME` 环境变量也一致；数字旧路径均解析到相同数据。6 个 bot connected=true，systemd active/running、NRestarts=0、ExecMainStatus=0。媒体路由从名称目录身份记录解析到原数字 bot ID，6 个均正确。

自动化验证为 410 项全量测试通过，typecheck、lint、build 和 diff check 通过。测试覆盖新目录、原目录迁移、用户名变化、离线启动、共享 home、同名冲突、非法路径、权限/链接保留及媒体目标路由。

以后按 `.env.example` 配置 `TG_BOT_TOKENS` 即默认启用名称目录。用户名由 Telegram getMe 获取；已有目录断网时继续使用记录的名称。首次离线启动暂用数字 ID，后续启动获取用户名后再迁移。名称冲突明确报错，不自动合并目录。`.foxclaw-bot.json` 只记录 bot ID，不保存凭据。

检查还发现一个原有授权问题：共享 home 中的 `auth.json` 指向 `/home/wuya/.codex/auth.json_GamsGo2`，该目标不存在。原目录本身即可复现断链；此次目录迁移保持该链接不变。桥连接正常不代表这个授权已可调用模型，本次没有为目录改名另行切换账号。
