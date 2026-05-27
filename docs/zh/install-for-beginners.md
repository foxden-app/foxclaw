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

## 2. 安装 Node.js 24+

FoxClaw 需要 Node.js 24+，因为它使用 Node 内置 SQLite 运行时。不强依赖 nvm；你可以用 nvm、fnm、asdf、mise、Volta、Homebrew 或系统包管理器安装。

如果已经安装 Node 24+，这条命令会输出 `v24...` 或更高版本：

```bash
node -v
```

如果不是 Node 24+，推荐普通用户用 `nvm` 安装，示例：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

如果使用 nvm 后 `node -v` 仍然显示旧版本，关闭终端，重新打开后运行：

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

这会创建默认配置文件 `~/.foxclaw/.env`，并提示你填写一个或多个 Telegram bot token（多个用英文逗号分隔）、Telegram 数字用户 ID 和默认工作目录。新安装使用 `TG_BOT_TOKENS`；旧的 `TG_BOT_TOKEN` 仅用于兼容已有单 bot 配置。

如果你用 pnpm：

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
```

## 7. 填写 `.env`

如果刚才在 `foxclaw init` 里已经填好了 token、用户 ID 和工作目录，可以直接进入下一步检查。如果你选择了跳过，或者想改配置，用简单编辑器打开：

```bash
nano ~/.foxclaw/.env
```

第一次私聊模式只需要重点填写这些值：

```dotenv
TG_BOT_TOKENS=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/a/folder
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

`TG_ALLOWED_CHAT_ID=` 和 `TG_ALLOWED_TOPIC_ID=` 第一次保持为空，不要删掉这两行；留空表示私聊模式。

只有一个 bot 时先按上面的配置跑通即可。需要三条互不打断的 Codex 会话时，把多个 token 写在同一行：

```dotenv
TG_BOT_TOKENS=123456789:token_a,234567890:token_b,345678901:token_c
```

FoxClaw 仍只安装一个服务，但每个 bot 会有独立 app-server、会话目录和当前 auth。服务启动后请分别私聊每个 bot 发送 `/help` 与 `/status`。

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
[OK] telegram bot token(s) configured
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
foxclaw restart
```

停止服务：

```bash
foxclaw stop
```

卸载 Linux 服务：

```bash
foxclaw uninstall-systemd
```

以后升级 FoxClaw：

```bash
foxclaw update
```

也可以在已授权的 Telegram 私聊里发送 `/update`。它会在所有 Telegram bot、已启用的微信默认 runtime 和 auth 镜像写入都空闲时，尝试升级 npm/pnpm 安装的 Codex CLI，完成 FoxClaw 升级、自检和服务重启，并在发起命令的 bot 中回报结果。

如果 `~/.foxclaw/.env` 已经存在，`foxclaw init` 会先询问是否更新 Telegram 和工作目录相关字段，其它配置保持不变。

## 鸣谢

FoxClaw 最初基于 `Gan-Xing/telegram-codex-app-bridge` fork 演进而来。感谢原项目对 Telegram 与 Codex 本地桥接思路的探索。

## 下一步

安装跑通后，继续看 [用户手册](./user-manual.md)，里面系统说明了 `/help`、`/setup`、`/threads`、`/watch`、`/auth`、Codex 登录和多账号轮转。
