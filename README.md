中文 ｜ [English](./README_EN.md)

# FoxClaw

FoxClaw 是 Foxden agents 的本地执行爪。

它运行在你自己的电脑上，让受信任的 Telegram 或微信聊天可以控制本机 Codex 环境。你不需要公网服务器：FoxClaw 通过本地 `codex app-server` 与 Codex 通信，把审批留在你的电脑上，并把工作会话发送回手机。

## 从这里开始

- 已经有 Codex、OpenClaw、QwenPaw、Hermes、OpenCode 或 Kimi CLI 这类能操作 shell 的 agent？优先使用 [Agent 辅助安装](./docs/agent-assisted-install.md)，这是推荐路径。
- 不熟悉 Node、Telegram 机器人或 Codex CLI？使用 [新手安装指南](./docs/install-for-beginners.md)。
- 已经熟悉 Git、Node 和 `.env` 文件？可以直接使用下面的快速设置。
- 遇到问题？查看 [故障排查](./docs/troubleshooting.md)。

如果你希望做到这些，FoxClaw 会很适合：

- 在手机上使用 Codex，同时不把自己的电脑暴露到公网
- 将代码、shell 访问、认证、审批和运行数据都保留在自己的机器上
- 让一个受信任的 Telegram 用户作为远程操作者

最小安装只需要一个 Telegram bot token、你的 Telegram 数字用户 ID、Node.js 24，以及一份已经登录的 `codex` CLI。首次安装通常需要 10-20 分钟。

30 秒产品示例：FoxClaw 运行后，向你的 Telegram 机器人发送 `List files in DEFAULT_CWD`。FoxClaw 会让本地 Codex 检查你电脑上的那个目录，并把答案发回 Telegram。

## 环境要求

- macOS 或 Linux，并且有可用的 `codex` CLI
- 主机上的 Codex 已完成认证
- Node.js 24+
- 来自 `@BotFather` 的 Telegram bot token
- 你的 Telegram 数字用户 ID

## 快速设置

```bash
git clone https://github.com/foxden-app/foxclaw.git
cd foxclaw
npm install
cp .env.example .env
$EDITOR .env
npm run build
npm run doctor
npm run serve
```

运行 `doctor` 或 `serve` 前先编辑 `.env`。私聊模式的最小配置：

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

FoxClaw 只接受来自 `TG_ALLOWED_USER_ID` 的消息。把机器人放进群组并不会让每个群成员都能使用它。

<details>
<summary>FoxClaw 运行后可以做什么</summary>

- 允许一个 Telegram 用户通过私聊、群组和话题控制
- 可选的微信/iLink 通道，复用同一套桥接核心
- 使用 `/threads`、`/open`、`/new`、`/where` 和 `/interrupt` 进行稳定的聊天到线程绑定
- 从手机控制线程生命周期：重命名、归档、取消归档、fork、回滚、compact、review 和 diff
- 面向单个聊天的设置面板：模型、reasoning effort、Fast service tier、access preset、Agent/Plan 模式和 active-turn 行为
- Codex 账户控制：`/account`、`/quota`、`/login_device`、`/login_cancel`、`/auth add <name>`，以及带保护的 `/logout confirm`
- 当某个认证触发用量限制时，在本地 `auth.json_*` 候选之间自动切换 Codex 认证
- 针对命令、文件变更和细粒度权限审批的内联按钮
- 针对工具在 turn 中提出的结构化问题显示 MCP elicitation 卡片
- Skills、MCP、hooks、plugins、apps、feature flags、config、requirements 和 provider diagnostics
- 使用 SQLite 持久化绑定、offset、审批、待处理输入提示和审计日志
- 单实例进程锁，避免同一个 bot token 上出现重复 Telegram polling

</details>

## 作为服务安装

Linux 用户级 systemd：

```bash
npm run install-systemd
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

macOS launchd：

```bash
./scripts/launchd/install.sh
```

默认运行时文件存储在 `~/.foxclaw`：

- store：`~/.foxclaw/data/bridge.sqlite`
- bridge log：`~/.foxclaw/logs/service.log`
- status：`~/.foxclaw/runtime/status.json`
- app-server state：`~/.foxclaw/runtime/codex-app-server.json`
- app-server log：`~/.foxclaw/logs/codex-app-server.log`

可以用 `STORE_PATH`、`LOCK_PATH`、`CODEX_APP_SERVER_STATE_PATH` 和 `CODEX_APP_SERVER_LOG_PATH` 覆盖 store、lock 和 app-server 路径。

## 从 telegram-codex-app-bridge 迁移

FoxClaw 最初 fork 自 `Gan-Xing/telegram-codex-app-bridge`，并继续以 MIT License 分发。

升级已有本地安装时：

```bash
systemctl --user disable --now telegram-codex-app-bridge.service 2>/dev/null || true
test -e ~/.foxclaw || cp -a ~/.telegram-codex-app-bridge ~/.foxclaw
npm run install-systemd
```

如果使用 launchd 安装，先卸载旧 plist（如存在）：

```bash
launchctl unload ~/Library/LaunchAgents/com.ganxing.telegram-codex-app-bridge.plist 2>/dev/null || true
./scripts/launchd/install.sh
```

旧运行时目录不会被自动读取。如果你想保留现有绑定、缓存线程列表、审批和状态数据，请手动复制一次。

## Telegram 设置

1. 使用 `@BotFather` 创建机器人，并把 token 填入 `TG_BOT_TOKEN`。
2. 获取你的 Telegram 数字用户 ID，并填入 `TG_ALLOWED_USER_ID`。
3. 使用 `npm run serve` 或服务安装器启动 FoxClaw。
4. 打开与机器人的私聊并发送 `/help`。

可选的群组/话题配置：

```dotenv
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
```

- 留空 `TG_ALLOWED_CHAT_ID` 表示使用私聊模式。
- 只设置 `TG_ALLOWED_CHAT_ID` 时，允许一个群组作为默认会话范围。
- 同时设置 `TG_ALLOWED_CHAT_ID` 和 `TG_ALLOWED_TOPIC_ID` 时，绑定一个话题作为默认范围。
- 即使配置了群组，`TG_ALLOWED_USER_ID` 仍然可以继续使用私聊。

查找群组和话题 ID：

1. 停止 FoxClaw。
2. 在目标群组或话题中发送一条消息。
3. 打开 `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`。
4. 读取 `message.chat.id` 作为 `TG_ALLOWED_CHAT_ID`。
5. 读取 `message.message_thread_id` 作为 `TG_ALLOWED_TOPIC_ID`。

如果 FoxClaw 还在运行，它可能会在你检查前消费掉该 update。

## Telegram 群组检查清单

对于群组或超级群里的自然语言消息：

1. 将机器人加入目标群组。
2. 在 `@BotFather` 中禁用机器人的 `privacy mode`。
3. 将机器人提升为该群管理员。
4. 如果是在加入群组后才修改隐私模式，请移除并重新加入机器人。

即使 privacy mode 阻止普通消息，`/status@botname` 这样的显式命令也可能正常工作，所以请用一条普通消息验证群组设置。

## Codex App-Server 生命周期

默认配置：

```dotenv
CODEX_APP_AUTOLAUNCH=true
CODEX_APP_LAUNCH_CMD=codex app
CODEX_APP_SERVER_STATE_PATH=
CODEX_APP_SERVER_LOG_PATH=
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
```

FoxClaw 会把 `codex app-server` 启动为一个由 bridge 管理的 detached 进程，并记录它的 pid 和端口。重启时，如果记录的 app-server 进程仍然存活，FoxClaw 会重新连接；否则会启动一个新进程。`/auth_reload` 和认证切换会重启托管的 app-server，从而重新加载当前 `auth.json`。

正常安装不需要固定的 Codex app-server 端口。

## 命令

- `/help`
- `/setup` 打开统一偏好设置面板
- `/fast <on|off|toggle>`
- `/active <steer|queue>`
- `/status`、`/account`、`/quota`
- `/quota_nudge <credits|usage_limit> confirm`
- `/login_device`、`/login_cancel [id]`、`/logout confirm`
- `/auth [list|use <n>|enable <n>|disable <n>|reload|add <name>]`
- `/threads [query]`、`/threads archived`、`/open <n>`
- `/goal [objective|pause|resume|done|budget <tokens|off>|clear confirm]`
- `/history [limit]`、`/files <query>`、`/remote`
- `/new [cwd]`
- `/steer <message>`、`/takeover <message>`、`/queue <message>`
- `/review [base <branch>|commit <sha>|custom <instructions>]`
- `/diff`、`/fork [name]`、`/undo [n]`、`/rollback [n]`
- `/rename <name>`、`/compact`、`/archive`、`/unarchive <n>`
- `/skills [query]`、`/skill <name>`、`/skill_enable <name>`、`/skill_disable <name>`
- `/loaded`、`/hooks`、`/plugins [query]`、`/apps [reload]`、`/features`、`/config`、`/requirements`、`/provider`
- `/mcp`、`/mcp_reload`、`/mcp_login <server>`、`/mcp_resource <server> <uri>`
- `/models`、`/model`、`/effort`、`/permissions`、`/access`、`/mode`、`/plan` 和 `/agent`
- `/reveal`、`/where`、`/interrupt`

普通文本会发送到当前线程；如果当前没有绑定线程，则创建一个新线程。

## 微信/iLink

微信支持是可选的，默认关闭：

```dotenv
WX_ENABLED=true
WX_ALLOWED_ILINK_USER_IDS=
```

构建后运行一次二维码登录助手：

```bash
npm run weixin-login
```

微信运行时文件默认存储在 `~/.foxclaw/weixin`。

## Codex Skill

本仓库内置一个 Codex skill：[`skills/foxclaw`](./skills/foxclaw)。当你想让 Codex 在本机或另一台 Mac 上通过 SSH bootstrap FoxClaw、写入 `.env`、构建、运行 doctor、安装 launchd，并指导首次消息验证时，可以使用它。

## 故障排查

`doctor` 失败、Telegram 没有回复、服务日志、重启行为和迁移问题，请查看 [故障排查](./docs/troubleshooting.md)。

## 运维命令

```bash
npm run build
npm run doctor
npm run status
npm run install-systemd
npm run uninstall-systemd
```

## 贡献

欢迎在 `https://github.com/foxden-app/foxclaw` 提交 issue 和 PR。
