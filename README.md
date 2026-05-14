中文 ｜ [English](./README_EN.md)

# 🦊 FoxClaw · 狸爪

**狸爪：一个更适配编程需求的移动端 Codex 控制器。**

FoxClaw（狸爪）的目标很直接：让你用手机控制本机的 Codex，把移动端变成一个真正能用的 web coding 入口。Telegram 或微信负责交互，`codex app-server` 负责本地执行；你发任务、看进度、批审批、切线程，Codex 在电脑上继续写代码。

这适合你离开办公桌去吃饭、在旅途中、在跑步机上，或者陪小孩逛公园的时候继续工作。人可以离开电脑，Codex 不必停；它会把关键进展、错误、审批请求和最终结果同步回手机。

不需要公网服务器。FoxClaw 跑在你自己的电脑上，代码、shell、认证、审批和运行数据都留在本机，只把你允许的操作入口暴露给受信任的聊天账号。

## 为什么是 FoxClaw

**为什么选 Codex 作为底层引擎？**

1. **开源且接口完整** — Codex 是 OpenAI 开源的 CLI agent，并提供 `codex app-server`。FoxClaw 不是模拟终端输入，而是通过更完整的接口读取线程、切换模型、处理审批和恢复会话。
2. **当前编码体验强** — FoxClaw 直接读取你本机 Codex 可用的模型列表；如果你的 Codex 环境已经有 GPT-5.5，就可以在手机端选择和使用它。对高强度编程工作流来说，Codex/GPT-5.5 的体感已经是很多人优先选择它的原因。
3. **多账号额度切换** — 免费额度、一个月 Plus/Team 试用、多账号小额度都可以纳入本地 `auth.json_*` 候选。5 小时限制一到，FoxClaw 自动切换下一个可用账号、重启 app-server 并重试刚才的请求。

**适合这些场景：**

- 🍜 离开办公桌去吃饭，Codex 继续编码，有审批需求时手机上点一下
- 🚶 通勤路上、旅途中，不用打开电脑也能下发任务、查看进展、继续调试
- 🏃 在跑步机上、陪小孩逛公园，持续监控 Codex 的编码进程
- 🔒 代码、shell、认证、审批、运行数据全部留在本机，不暴露到公网
- 👤 只允许一个受信任的 Telegram 用户远程操作

## 从这里开始

- 手头有 Codex、OpenClaw、QwenPaw、Hermes、OpenCode、Kimi CLI 之类能跑 shell 的 agent？推荐走 [Agent 辅助安装](./docs/zh/agent-assisted-install.md)。
- 对 Node、Telegram 机器人、Codex CLI 不太熟？看 [新手安装指南](./docs/zh/install-for-beginners.md)。
- 已经装好，想系统了解 `/help`、`/setup`、`/threads`、`/watch`、`/auth` 和账号轮转？看 [用户手册](./docs/zh/user-manual.md)。
- Git、Node、`.env` 都玩得转？直接往下看快速设置。
- 卡住了？看 [故障排查](./docs/zh/troubleshooting.md)。

最低要求：一个 Telegram bot token、你的 Telegram 数字用户 ID、Node.js 24、一份已登录的 `codex` CLI。首次安装大约 10–20 分钟。

**30 秒体验**：启动 FoxClaw 后，给你的 Telegram 机器人发一句 `List files in DEFAULT_CWD`。Codex 会在本地检查那个目录，然后把结果发回 Telegram。

## 环境要求

- macOS 或 Linux，`codex` CLI 可用
- Codex 已完成登录认证
- Node.js 24+
- 一个 `@BotFather` 创建的 Telegram bot token
- 你的 Telegram 数字用户 ID

## 快速设置

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
$EDITOR ~/.foxclaw/.env
foxclaw doctor
foxclaw start
```

pnpm 用户：

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
$EDITOR ~/.foxclaw/.env
foxclaw doctor
foxclaw start
```

跑 `doctor` 或 `start` 之前先把 `.env` 填好。私聊模式最小配置：

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

配置文件默认在 `~/.foxclaw/.env`。想放别处的话设 `FOXCLAW_ENV=/path/to/.env`。

`foxclaw start` 会自动检查环境并安装/重启后台服务，幂等操作，升级后再跑一次就行。

FoxClaw 只响应 `TG_ALLOWED_USER_ID` 的消息——把机器人拉进群不代表群里所有人都能用。

<details>
<summary>FoxClaw 能做什么</summary>

**核心能力：**
- 通过 Telegram 私聊、群组、话题控制本地 Codex
- 可选微信/iLink 通道，复用同一套桥接核心
- 手机上完整管理 Codex 线程生命周期：创建、重命名、归档、fork、回滚、compact、review、diff
- 命令、文件变更、细粒度权限审批的内联按钮——手机上一键审批
- MCP elicitation 卡片——工具在 turn 中提出结构化问题时展示

**多账号管理：**
- Codex 账户管理：`/account`、`/quota`、`/login_device`、`/auth add <name>`
- 触发用量限制时自动在本地 `auth.json_*` 之间切换认证——5 小时限制到了自动换号
- `/auth` 面板查看、启用、禁用、切换候选账号

**线程与会话：**
- `/threads`、`/open`、`/new`、`/where`、`/interrupt`——稳定的聊天-线程绑定
- 每个聊天独立的设置面板：模型、reasoning effort、Fast tier、access preset、Agent/Plan 模式
- Skills、MCP、hooks、plugins、apps、feature flags、config、requirements、provider diagnostics

**可靠性：**
- SQLite 持久化：绑定、offset、审批、待处理提示、审计日志
- 单实例进程锁，防止同一 bot token 重复 polling

</details>

## 多账号切换

FoxClaw 的一大特色是自动多账号切换。当一个账号的 5 小时用量限制触发时，FoxClaw 会自动切换到下一个可用账号继续工作。

设置方式：

1. 在 Codex 的 auth 目录（通常是 `~/.codex/`）中放置多个认证文件，命名为 `auth.json_personal`、`auth.json_team` 等。
2. 用 `/auth add <name>` 通过 Telegram 直接添加新账号。
3. 用 `/auth` 查看所有候选账号状态。
4. 用 `/auth enable <n>` / `/auth disable <n>` 控制哪些账号参与自动轮换。

当 Codex 报告用量限制错误时，FoxClaw 会自动：
- 切换到下一个未失败的候选账号
- 重启 app-server 加载新认证
- 用新账号重试刚才失败的请求

## 服务与调试

推荐方式：

```bash
foxclaw start
```

Linux 上会安装/重启用户级 systemd 服务，macOS 上安装/重载 launchd。查看状态：

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

也可以直接用包装命令：

```bash
foxclaw status
foxclaw restart
foxclaw stop
```

需要前台调试时：

```bash
foxclaw serve
```

运行时文件默认在 `~/.foxclaw`：

| 用途 | 路径 |
|------|------|
| 数据库 | `~/.foxclaw/data/bridge.sqlite` |
| Bridge 日志 | `~/.foxclaw/logs/service.log` |
| 状态 | `~/.foxclaw/runtime/status.json` |
| App-server 状态 | `~/.foxclaw/runtime/codex-app-server.json` |
| App-server 日志 | `~/.foxclaw/logs/codex-app-server.log` |

可通过 `STORE_PATH`、`LOCK_PATH`、`CODEX_APP_SERVER_STATE_PATH`、`CODEX_APP_SERVER_LOG_PATH` 覆盖。

## 从 telegram-codex-app-bridge 迁移

FoxClaw 最初 fork 自 `Gan-Xing/telegram-codex-app-bridge`，继续以 MIT License 分发。

升级已有安装：

```bash
systemctl --user disable --now telegram-codex-app-bridge.service 2>/dev/null || true
test -e ~/.foxclaw || cp -a ~/.telegram-codex-app-bridge ~/.foxclaw
foxclaw start
```

macOS launchd 用户先卸载旧 plist：

```bash
launchctl unload ~/Library/LaunchAgents/com.ganxing.telegram-codex-app-bridge.plist 2>/dev/null || true
foxclaw start
```

旧目录不会被自动读取。如果要保留已有的绑定、线程缓存、审批和状态数据，手动复制一次即可。

## Telegram 设置

1. 用 `@BotFather` 创建机器人，token 填入 `TG_BOT_TOKEN`。
2. 拿到你的 Telegram 数字用户 ID，填入 `TG_ALLOWED_USER_ID`。
3. `foxclaw start` 启动。
4. 打开和机器人的私聊，发 `/help`。

可选——群组/话题配置：

```dotenv
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
```

- `TG_ALLOWED_CHAT_ID` 留空 → 纯私聊模式。
- 只填 `TG_ALLOWED_CHAT_ID` → 允许一个群组作为默认会话范围。
- 两个都填 → 绑定到某个话题。
- 配了群组后，`TG_ALLOWED_USER_ID` 的私聊依然可用。

**怎么找群组和话题 ID：**

1. 先停掉 FoxClaw。
2. 在目标群组/话题里发一条消息。
3. 浏览器打开 `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`。
4. 找 `message.chat.id` → 填 `TG_ALLOWED_CHAT_ID`。
5. 找 `message.message_thread_id` → 填 `TG_ALLOWED_TOPIC_ID`。

> 如果 FoxClaw 还在跑，它可能会先把这条 update 消费掉，所以要先停。

## Telegram 群组检查清单

要让机器人在群组/超级群里收到普通消息：

1. 把机器人加进目标群组。
2. 在 `@BotFather` 里关掉 `privacy mode`。
3. 把机器人设为群管理员。
4. 如果是加群之后才改的隐私模式，把机器人踢出去再重新加。

> 注意：即使 privacy mode 挡住了普通消息，`/status@botname` 这种显式命令可能还是能用的。所以验证群组设置时，请用一条普通文本消息测试。

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

FoxClaw 会把 `codex app-server` 作为 detached 子进程启动，记录其 pid 和端口。重启时如果进程还活着就直接重连，否则拉起新进程。`/auth_reload` 和认证切换会重启 app-server 以重新加载 `auth.json`。

一般不需要手动固定 app-server 端口。

## 命令

- `/help`
- `/setup` — 统一设置面板
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
- `/models`、`/model`、`/effort`、`/permissions`、`/access`、`/mode`、`/plan`、`/agent`
- `/reveal`、`/where`、`/interrupt`

直接发文本会送到当前线程；没有绑定线程时自动创建新线程。

## 微信/iLink

微信支持默认关闭，需要手动开启：

```dotenv
WX_ENABLED=true
WX_ALLOWED_ILINK_USER_IDS=
```

构建完成后跑一次二维码登录：

```bash
foxclaw weixin-login
```

微信运行时文件在 `~/.foxclaw/weixin`。

## Codex Skill

仓库自带一个 Codex skill。用法看 [FoxClaw Skill 中文说明](./docs/zh/foxclaw-skill.md)。它可以让 Codex 通过 SSH 在本机或远程 Mac 上 bootstrap FoxClaw——写 `.env`、构建、跑 doctor、装 launchd、引导首次消息验证，一条龙。

## 故障排查

`doctor` 报错、Telegram 没回复、服务日志看不懂、重启行为异常、迁移出问题——都看 [故障排查](./docs/zh/troubleshooting.md)。

## 运维命令

```bash
foxclaw doctor
foxclaw status
foxclaw start
foxclaw restart
foxclaw stop
foxclaw uninstall-systemd
```

## 贡献

欢迎到 [GitHub](https://github.com/foxden-app/foxclaw) 提 issue 和 PR。
