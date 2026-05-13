# 新手安装指南

这份指南面向第一次安装 FoxClaw 的用户。你只需要能打开终端、复制命令、编辑一个配置文件，不需要提前熟悉 Node.js、Telegram bot 或 Codex CLI。

FoxClaw 跑在你的电脑上。手机发消息给 Telegram bot，bot 把消息交给 FoxClaw，FoxClaw 再控制本机 Codex。整个过程不需要公网服务器。

如果这台电脑上已经有 Codex、OpenClaw、QwenPaw、Hermes、OpenCode、Kimi CLI 这类能跑 shell 的 agent，优先看 [Agent 辅助安装](./agent-assisted-install.md)。

开始前先记住：

- 第一次先用 Telegram 私聊，不要先配群组。
- 不要把 bot token 发给不信任的人。
- 第一次不要把 `/`、`/Users`、`/home` 或整个 home 目录设为 `DEFAULT_CWD`。
- 日常启动用 `foxclaw start`，前台模式只用于排障。

## 1. 准备

你需要：

- 一台可以持续开机的 macOS 或 Linux 电脑
- 一个 Telegram 账号
- 一个已可使用的 Codex 账号
- 一个 Codex 可以工作的目录，例如 `~/Projects` 或 `~/Desktop`
- 第一次安装大约 10-20 分钟

## 2. 安装 Node.js 24

FoxClaw 需要 Node.js 24，因为它使用 Node 内置 SQLite 运行时。

如果已经安装 Node 24，这条命令会输出 `v24...`：

```bash
node -v
```

如果不是 Node 24，推荐用 `nvm` 安装：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

如果 `node -v` 仍然显示旧版本，关闭终端，重新打开后运行：

```bash
nvm use 24
```

## 3. 安装并登录 Codex

FoxClaw 不创建 Codex 账号，它使用这台电脑上已经登录的 Codex CLI。

如果还没有安装 Codex CLI：

```bash
npm install -g @openai/codex
```

如果遇到 `EACCES`、`EPERM` 或 `permission denied`，不要反复加 `sudo` 硬装，先看 [故障排查](./troubleshooting.md)。

登录 Codex：

```bash
codex login
```

检查命令是否存在：

```bash
codex --version
```

`codex --version` 只能证明命令存在。要确认认证可用，直接启动 Codex 并发一个小请求：

```bash
codex
```

然后输入：

```text
Say ready and exit.
```

如果你的 CLI 支持 `codex login status`，也可以用它辅助检查；真正可靠的验证是 Codex 能正常回答一个普通请求。

## 4. 创建 Telegram Bot

1. 打开 Telegram。
2. 搜索 `@BotFather`。
3. 发送 `/newbot`。
4. 按提示选择 bot 名称。
5. 复制 bot token，它看起来像 `123456789:AA...`。

请保存好这个 token。拿到 token 的人可以控制这个 bot。

## 5. 获取 Telegram 数字用户 ID

FoxClaw 只接受一个已配置用户的消息。

最简单的方式：

1. 打开 Telegram。
2. 搜索 `@userinfobot`。
3. 给它发任意消息或点击 Start。
4. 复制数字 `Id`。

请使用数字 ID，不要填 `@username`。

## 6. 安装 FoxClaw

用 npm 安装发布包：

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
```

这会创建默认配置文件 `~/.foxclaw/.env`。

如果你用 pnpm：

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
```

## 7. 填写 `.env`

用简单编辑器打开配置：

```bash
nano ~/.foxclaw/.env
```

第一次私聊模式只需要重点填写这些值：

```dotenv
TG_BOT_TOKEN=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/a/folder
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

`TG_ALLOWED_CHAT_ID=` 和 `TG_ALLOWED_TOPIC_ID=` 第一次保持为空，不要删掉这两行；留空表示私聊模式。

`DEFAULT_CWD` 必须是真实存在的目录，例如：

```dotenv
DEFAULT_CWD=/Users/alice/Desktop
DEFAULT_CWD=/home/alice/projects
```

在 `nano` 中按 `Ctrl+O`、回车、`Ctrl+X` 保存退出。

## 8. 运行检查

执行：

```bash
foxclaw doctor
```

理想情况下会看到：

```text
[OK] node >= 24
[OK] codex cli available
[OK] telegram bot token configured
[OK] telegram allowed user configured
[OK] default cwd exists
```

如果看到 `[FAIL]`，先看 [故障排查](./troubleshooting.md)。

## 9. 启动 FoxClaw

启动或重启后台服务：

```bash
foxclaw start
```

这个命令可以重复执行。它会跑检查，并按当前系统安装或重启后台服务。

打开你的 Telegram bot，先发：

```text
/help
```

如果 bot 回复了，再发：

```text
/status
```

然后试一个普通请求：

```text
List the files in the current working directory.
```

还可以试：

```text
/setup
```

```text
List files in DEFAULT_CWD.
```

```text
Create a short README-style summary of this folder.
```

```text
/interrupt
```

## 10. 服务命令

Linux 上 `foxclaw start` 管理用户级 systemd 服务。查看状态：

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

如果希望重启后未登录也能启动用户服务：

```bash
loginctl enable-linger "$USER"
```

macOS 上 `foxclaw start` 管理 launchd，并在你登录后启动 FoxClaw。

前台调试时，先停后台服务，再运行 `foxclaw serve`。

## 11. 日常维护

查看状态：

```bash
foxclaw status
```

修改 `.env` 后重启：

```bash
foxclaw start
```

停止 Linux 服务：

```bash
systemctl --user stop foxclaw.service
```

卸载 Linux 服务：

```bash
foxclaw uninstall-systemd
```

以后升级 FoxClaw：

```bash
npm install -g @foxden-app/foxclaw@latest
foxclaw start
```

## 从旧项目名迁移

如果这台机器仍在运行 `telegram-codex-app-bridge`，迁移一次即可：

```bash
systemctl --user disable --now telegram-codex-app-bridge.service 2>/dev/null || true
test -e ~/.foxclaw || cp -a ~/.telegram-codex-app-bridge ~/.foxclaw
npm install -g @foxden-app/foxclaw@latest
foxclaw init
foxclaw doctor
foxclaw start
```

如果 `~/.foxclaw/.env` 已经存在，`foxclaw init` 不会覆盖它。
