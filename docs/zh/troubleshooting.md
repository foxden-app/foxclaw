# 故障排查

先从这两条命令开始：

```bash
foxclaw doctor
foxclaw status
```

如果 FoxClaw 是 Linux 用户级服务，再看：

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

## Doctor 检查失败

| 现象 | 含义 | 处理方式 |
| --- | --- | --- |
| `[FAIL] node >= 24` | 当前 shell 使用的是旧版 Node.js。 | 先用任意方式安装或切换到 Node.js 24+，再重新执行 `foxclaw doctor`。如果服务仍用旧 Node，从 Node 24+ 的 shell 里重新执行 `foxclaw start`。 |
| `[FAIL] codex cli available` | `codex` 命令不在 PATH 里。 | 安装 Codex CLI 或修正 PATH，再确认 `codex --version` 可用。 |
| `[FAIL] telegram bot token(s) configured` | `.env` 里没有 `TG_BOT_TOKENS`，也没有兼容变量 `TG_BOT_TOKEN`。 | 从 `@BotFather` 复制一个或多个 token，用逗号分隔填入 `TG_BOT_TOKENS`。 |
| `[FAIL] telegram allowed user configured` | `.env` 里缺少 `TG_ALLOWED_USER_ID`。 | 从 `@userinfobot` 获取数字 ID，填入 `.env`。 |
| `[FAIL] default cwd exists` | `DEFAULT_CWD` 指向不存在的目录。 | 创建该目录，或把 `DEFAULT_CWD` 改成一个真实存在的绝对路径。 |

## Node 或 npm 不存在

如果看到 `node: command not found` 或 `npm: command not found`，先用你习惯的方式安装 Node.js 24+，例如 nvm、fnm、asdf、mise、Volta、Homebrew 或系统包管理器。下面是 nvm 示例：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

如果使用 nvm 后仍然失败，关闭终端，重新打开后运行：

```bash
nvm use 24
```

## npm 权限错误

如果 `npm install -g @openai/codex` 或 `npm install -g @foxden-app/foxclaw` 报 `EACCES`、`EPERM`、`permission denied`，说明当前全局 npm 目录不可写。

推荐处理方式是使用一个用户级 Node.js 24+，然后重新安装。下面是 nvm 示例：

```bash
nvm install 24
nvm use 24
npm install -g @openai/codex
npm install -g @foxden-app/foxclaw
```

除非你很清楚本机 Node 的安装方式，否则不要直接混用 `sudo npm install -g ...`。`sudo`、系统 Node 和用户级 Node 管理器混在一起，常见结果是 PATH 断掉或服务启动时找不到命令。

如果 `codex` 已安装但 FoxClaw 找不到它，先定位二进制：

```bash
command -v codex
```

然后把绝对路径写进 `.env`：

```dotenv
CODEX_CLI_BIN=/absolute/path/to/codex
```

## Bot 没有回复

按顺序检查：

1. 确认 FoxClaw 正在运行：

   ```bash
   foxclaw status
   ```

2. 先用私聊测试。直接打开 bot 发：

   ```text
   /help
   ```

3. 确认 `TG_ALLOWED_USER_ID` 是你的 Telegram 数字 ID，不是 `@username`。

4. 确认 `.env` 里的 bot token 属于你正在聊天的 bot。

5. 修改 `.env` 后重启：

   ```bash
   foxclaw restart
   ```

   如果正在前台运行，先 `Ctrl+C` 停止，再重新运行 `foxclaw serve`。

## 群组消息不生效

私聊模式最简单。群组或话题模式请检查：

1. 已把 bot 加入目标群组。
2. 已在 `@BotFather` 里关闭 bot 的 `privacy mode`。
3. 已把 bot 提升为群管理员。
4. 如果是加群后才关闭隐私模式，先把 bot 踢出群再重新加入。
5. 已配置 `TG_ALLOWED_CHAT_ID`，必要时也配置 `TG_ALLOWED_TOPIC_ID`。

`/status@botname` 这种显式命令有时会在隐私模式下仍然可用，所以验证群组配置时请用普通自然语言消息测试。

## 获取群组或话题 ID

1. 停掉 FoxClaw。
2. 在目标群组或话题里发一条新消息。
3. 浏览器打开：

   ```text
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

4. 用 `message.chat.id` 作为 `TG_ALLOWED_CHAT_ID`。
5. 用 `message.message_thread_id` 作为 `TG_ALLOWED_TOPIC_ID`。

如果 FoxClaw 还在运行，它可能会先消费这条 update，导致你在浏览器里看不到。

## Telegram polling 冲突

如果 Telegram 报 conflict，或者同一个 bot 行为异常，通常是两个进程在轮询同一个 bot token。

检查服务和额外的前台进程：

```bash
systemctl --user is-active foxclaw.service
pgrep -af foxclaw
```

停掉多余进程或服务后，重启 FoxClaw：

```bash
foxclaw restart
```

## Codex 或 app-server 异常

FoxClaw 需要本机 Codex 已登录。先检查命令：

```bash
codex --version
```

如果没有登录：

```bash
codex login
```

`codex --version` 只证明命令存在。要验证认证真的可用，运行：

```bash
codex
```

然后输入：

```text
Say ready and exit.
```

如果你的 CLI 支持 `codex login status`，也可以一起看；但普通请求能成功回答才是最直接的验证。

FoxClaw app-server 日志默认在：

```bash
tail -f ~/.foxclaw/logs/codex-app-server.log
```

Bridge 日志默认在：

```bash
tail -f ~/.foxclaw/logs/service.log
```

## 多 bot 模式核查

配置 `TG_BOT_TOKENS` 后，`foxclaw status` 的 `bots` 列表应为每个 token 显示一个 bot id、连接状态和 runtime 类型。私聊任一 bot 发送 `/status` 会显示全部 runtime 摘要；发送 `/auth` 应显示当前 `@botname` 和该 bot 的 auth 目录。如果 `TG_BOT_TOKEN` 精确匹配 `TG_BOT_TOKENS` 中的一个 token，该 bot 应显示为默认/终端共享 runtime；其他 bot 应显示为隔离 runtime。

每个隔离 app-server 的日志路径为：

```bash
tail -f ~/.foxclaw/logs/codex-app-server-bot<id>.log
```

群组里配置了多个 bot 时，普通未点名消息不会触发它们；使用 `@botname`、回复目标 bot，或 `/status@botname`。微信启用后仍使用默认 Codex runtime，不会出现在某个 Telegram bot 的隔离线程中。

## ChatGPT 后端 403 或 Unable to load site

如果 Telegram 里看到 `ChatGPT backend 403 Forbidden`，或者 app-server 日志里出现 `Unable to load site`、`cf-ray`、`chatgpt.com/backend-api`，通常不是 `auth.json` 文件坏了，而是服务进程访问 ChatGPT 后端时没有走正确网络。

常见原因是：你在 shell 里配置了代理，或者项目 `.env` 里有代理，但 systemd/launchd 服务实际读的是另一个 env 文件。先看服务用的是哪个 env：

```bash
systemctl --user cat foxclaw.service
```

`foxclaw init` 会检测当前 shell 里的代理环境变量，并询问是否保存到 FoxClaw `.env`。如果你跳过了这一步，`foxclaw doctor` 会在发现“shell 有代理，但 FoxClaw env 没有代理”时给出 `[WARN]`。

确认 `Environment=FOXCLAW_ENV=...` 指向的文件里有你的代理配置，例如：

```dotenv
HTTP_PROXY=http://127.0.0.1:20171
HTTPS_PROXY=http://127.0.0.1:20171
ALL_PROXY=socks5://127.0.0.1:20170
NO_PROXY=127.0.0.1,localhost
```

只要配置了 `HTTP_PROXY` 或 `HTTPS_PROXY`，FoxClaw 安装 systemd/launchd 时会把这些变量显式传给服务，并给 Node 加上 `--use-env-proxy`。不要依赖“当前 shell 里有代理变量”，服务进程不会自动继承它们。

改完后重启 FoxClaw。重启会同时重启托管的 Codex app-server，让新代理生效：

```bash
foxclaw restart
```

如果这台 Linux 机器必须用 `proxychains4` 才能访问 Telegram 或 ChatGPT，不要手写 systemd drop-in 覆盖 `ExecStart`。在 FoxClaw env 文件里写：

```dotenv
FOXCLAW_PROXYCHAINS_CONF=/home/wuya/.proxychains-rt.conf
```

然后运行：

```bash
foxclaw restart
```

FoxClaw 会把 proxychains 写进主 service，并清理旧的 FoxClaw `ExecStart` 覆盖，后续升级直接运行 `foxclaw update` 即可。

## 服务用了错误的 Node 版本

systemd 安装脚本会记录当时正在运行的 Node 绝对路径，不依赖 systemd 去加载 `nvm.sh` 或其它 shell 初始化脚本。无论你用 nvm、fnm、asdf、mise、Volta、Homebrew 还是系统 Node，原则都是：从 Node 24+ 的 shell 里执行 `foxclaw start`，服务之后就固定使用这个 Node 24+ 路径。

如果你从 Node 22 或更旧版本的 shell 里安装过服务，请从 Node 24+ 的 shell 重新安装。nvm 用户示例：

```bash
nvm use 24
foxclaw start
systemctl --user status foxclaw.service
```

状态输出里应该能看到 Node 24+ 的路径。`foxclaw doctor` 也会检查已安装服务里的 Node 路径，如果发现路径不存在或版本低于 24，会提示重新运行 `foxclaw start`。

## 重启后是否会自动运行

Linux 用户级 systemd：

```bash
systemctl --user is-enabled foxclaw.service
```

`enabled` 表示会随用户会话启动。如果希望机器重启后未登录也启动用户服务：

```bash
loginctl enable-linger "$USER"
```

macOS 上，运行过下面命令后，FoxClaw 会在你登录时由 launchd 启动：

```bash
foxclaw start
```
