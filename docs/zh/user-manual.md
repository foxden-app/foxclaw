# FoxClaw 用户手册

FoxClaw 把本机 Codex 包成一个可从手机控制的服务。Telegram 或微信负责聊天入口，FoxClaw 负责鉴权、线程绑定、审批、设置面板和账号切换，真正执行代码的是你电脑上的 `codex app-server`。

典型链路：

```text
手机 Telegram/微信
  -> FoxClaw bot
  -> 本机 FoxClaw 服务
  -> codex app-server
  -> DEFAULT_CWD 或当前线程目录
```

代码、shell 权限、Codex 认证和运行数据都留在这台电脑上。第一次安装建议先跑通 Telegram 私聊，再考虑群组、话题或微信通道。

## 1. 完整安装流程

### 1.1 安装 Node.js 24

FoxClaw 需要 Node.js 24。先检查：

```bash
node -v
```

如果不是 `v24...`，推荐用 `nvm`：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
```

### 1.2 安装并登录 Codex

FoxClaw 不替你创建 Codex 账号，它使用这台机器上已经登录的 Codex CLI。

```bash
npm install -g @openai/codex
codex login
codex --version
```

`codex --version` 只能证明命令存在。真正的验证方式是启动 Codex 并让它完成一个小请求：

```bash
codex
```

然后输入：

```text
Say ready and exit.
```

如果 Codex 能正常回答，FoxClaw 才有可用的底层执行环境。

### 1.3 创建 Telegram bot

1. 打开 Telegram。
2. 搜索 `@BotFather`。
3. 发送 `/newbot`。
4. 按提示设置 bot 名称和 username。
5. 复制 bot token，格式类似 `123456789:AA...`。

这个 token 等同于 bot 的控制权，不要发给不信任的人。

### 1.4 获取 Telegram 数字用户 ID

FoxClaw 只响应 `TG_ALLOWED_USER_ID` 配置的用户。

1. 打开 Telegram。
2. 搜索 `@userinfobot`。
3. 给它发任意消息或点击 Start。
4. 复制返回里的数字 `Id`。

请填数字 ID，不要填 `@username`。

### 1.5 安装 FoxClaw

如果你用 pnpm 管理全局包：

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
```

如果你用 npm：

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
```

两种方式都安装同一个 npm 发布包。建议一台机器上固定使用一种全局包管理器，避免 PATH 里出现多个版本。

### 1.6 填写配置

`foxclaw init` 会创建默认配置文件 `~/.foxclaw/.env`，并提示填写 Telegram bot token、Telegram 数字用户 ID 和默认工作目录。任何一项都可以直接回车跳过，之后再手动编辑：

```bash
$EDITOR ~/.foxclaw/.env
```

第一次私聊模式的最小配置：

```dotenv
TG_BOT_TOKEN=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

字段说明：

- `TG_BOT_TOKEN`：从 `@BotFather` 拿到的 bot token。
- `TG_ALLOWED_USER_ID`：你的 Telegram 数字用户 ID。
- `TG_ALLOWED_CHAT_ID`：第一次保持为空，表示私聊模式。
- `TG_ALLOWED_TOPIC_ID`：第一次保持为空，表示不绑定 Telegram 话题。
- `DEFAULT_CWD`：Codex 默认工作的目录，必须真实存在。
- `DEFAULT_APPROVAL_POLICY`：建议首次使用 `on-request`，需要时手机审批。
- `DEFAULT_SANDBOX_MODE`：建议首次使用 `workspace-write`。

### 1.7 检查并启动

```bash
foxclaw doctor
foxclaw start
foxclaw status
```

Linux 查看服务日志：

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

macOS 上 `foxclaw start` 会管理 launchd。前台排障时，先停后台服务，再运行：

```bash
foxclaw stop
foxclaw serve
```

### 1.8 第一次 Telegram 验证

打开你的 bot 私聊，依次发送：

```text
/help
```

```text
/status
```

```text
/setup
```

然后发一个普通请求：

```text
List files in DEFAULT_CWD.
```

如果能收到 Codex 返回，基础链路已经跑通。

## 2. 群组和话题

私聊最稳。确认私聊可用后，再配置群组或 topic。

```dotenv
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
```

- `TG_ALLOWED_CHAT_ID` 留空：只使用私聊。
- 只填 `TG_ALLOWED_CHAT_ID`：允许一个群作为默认会话范围。
- 两个都填：绑定到某个 topic。
- 配了群组后，`TG_ALLOWED_USER_ID` 的私聊仍然可用。

获取群组或 topic ID：

1. 停掉 FoxClaw。
2. 在目标群组或 topic 里发一条消息。
3. 浏览器打开：

   ```text
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

4. 用 `message.chat.id` 填 `TG_ALLOWED_CHAT_ID`。
5. 用 `message.message_thread_id` 填 `TG_ALLOWED_TOPIC_ID`。

如果 FoxClaw 还在运行，它可能已经消费掉这条 update，浏览器里就看不到。

群组里还需要：

- 把 bot 加入群。
- 在 `@BotFather` 里关闭 privacy mode。
- 把 bot 设为群管理员。
- 用普通自然语言消息验证，不要只用 `/status@botname` 验证。

## 3. 命令使用说明

### 3.1 `/help`

`/help` 返回当前可用命令列表。顶部会固定显示最常用入口：

```text
/help
/setup
/status
/threads [query]
/auth
```

后面的命令会按你最近使用情况排序。直接发送普通文本、图片或文件时，FoxClaw 会继续当前绑定线程；如果没有绑定线程，会自动新建线程。

### 3.2 `/status`、`/account`、`/quota`

- `/status`：查看 FoxClaw、app-server、当前绑定线程、模型、权限和 Codex 用量摘要。
- `/account`：查看当前 Codex 登录账号。
- `/quota`：查看 Codex 用量和额度窗口。

### 3.3 `/config`、`/requirements`、`/provider`

- `/config`：读取当前线程目录或 `DEFAULT_CWD` 下的 Codex 配置摘要，包含 `model`、`approval_policy`、`sandbox_mode`、`service_tier` 等关键项。
- `/requirements`：查看 app-server 暴露的配置约束，例如允许的 approval、sandbox、web search 模式。
- `/provider`：查看当前 Codex provider 配置摘要。

这些命令适合排查“为什么手机上跑出来的权限、模型或 provider 和预期不同”。

## 4. `/setup` 会话设置面板

`/setup` 是手机端最重要的面板之一。它按聊天范围保存设置，私聊、群组、topic 可以有不同设置。

它能配置：

- 模型：使用服务端默认模型，或选择 app-server 返回的模型。
- reasoning effort：例如 `low`、`medium`、`high`、`xhigh`，取决于模型支持情况。
- Fast tier：模型支持时可开关 fast 服务档。
- Access：`read-only`、`default`、`full-access`。
- Mode：`Agent` 或 `Plan`。
- Active turn：新消息是 steer 当前 turn，还是 queue 到下一轮。

Telegram 会把 HTML 和按钮渲染出来。这里用等宽框模拟实际面板：

```text
会话偏好
当前：gpt-5.5 · high · fast=off · default · Agent · Steer current turn
Focus: Model

Model: gpt-5.5
Effort: high
Fast: off
Access: Default (on-request / workspace-write)
Mode: Agent
Active turn: Steer current turn

[自动]           [gpt-5.5]
[low] [medium] [high]
[⚡ Fast on]     [Fast off]
[👁️ Read-only]  [🛡️ Default]  [🔓 Full access]
[Agent]          [📝 Plan]
[Steer current turn] [Queue next turn]
```

常用命令别名：

- `/model <model|default>`：快速切模型。
- `/effort <effort|default>`：快速切 reasoning effort。
- `/permissions [read-only|default|full-access]`：快速切权限预设。
- `/mode [default|plan]`：切 Agent/Plan。
- `/active <steer|queue>`：控制当前 turn 有新消息时的处理方式。

## 5. 线程和观察

FoxClaw 的聊天是“绑定线程”的。你在手机上打开某个 Codex 线程后，普通消息会继续发到这个线程。

常用命令：

- `/threads [query]`：列出最近线程，可加关键词过滤。
- `/threads archived [query]`：列出已归档线程。
- `/open <n>`：打开最近一次 `/threads` 列表里的第 n 个线程，并绑定当前聊天。
- `/new [cwd]`：在指定目录或默认目录新建线程。
- `/where`：查看当前聊天绑定到哪个线程、目录和设置。
- `/rename <name>`：重命名当前线程。
- `/archive`：归档当前线程。
- `/interrupt`：中断当前正在跑的 turn。

线程面板示意：

```text
最近线程
点击下方按钮即可切换或管理线程。
显示第 1-5 条
当前：fix auth rotation
~/Projects/foxclaw | 3 minutes ago | idle

[🧵 1. fix auth rotation]
[✏️] [👀] [🗑️] [➕]

[🧵 2. polish README copy]
[✏️] [👀] [🗑️] [➕]

[➕ 新建]
[➡️ 下一页]
[🗄️ 已归档]
```

### `/watch`

`/watch` 用来观察一个线程，不一定要从这个聊天发起任务。常见场景是你在电脑上的 Codex CLI 里启动了长任务，然后出门，用手机观察进展。

用法：

- `/watch`：观察当前绑定线程。
- `/watch <n>`：观察最近一次 `/threads` 列表里的第 n 个线程。
- `/unwatch`：停止观察。

观察模式会同步 live turn 进展和审批请求。观察中的聊天默认是只读的，普通 prompt 不会直接插入正在观察的 turn；需要发新任务时先 `/unwatch`，或等当前 turn 完成。

## 6. Codex 登录和 auth 轮转

这是 FoxClaw 的特色功能。Codex 的登录状态通常保存在 `~/.codex/auth.json`。FoxClaw 把多个账号保存成候选文件，并通过切换 `auth.json` 指向哪个候选来换号。

### 6.1 文件格式

候选文件放在 Codex auth 目录，默认是 `~/.codex/`。如果你设置了 `CODEX_AUTH_DIR`，则使用那个目录。

推荐命名：

```text
~/.codex/
  auth.json -> /home/alice/.codex/auth.json_personal
  auth.json_personal
  auth.json_team
  auth.json_plus_trial
```

FoxClaw 识别这些候选文件名：

- `auth.json_<name>`
- `auth.json.<name>`
- `auth.json-<name>`

`auth.json` 是 Codex 当前使用的文件。切换账号时，FoxClaw 会把 `auth.json` 指向某个候选文件。候选文件内容是 Codex CLI 生成的 JSON，FoxClaw 不依赖里面的私密字段，也不建议手写这些字段。

如果你已经有一个可用的 `auth.json`，可以先备份成候选：

```bash
cp -L ~/.codex/auth.json ~/.codex/auth.json_personal
```

更推荐用 `/auth add <name>` 从手机端添加新候选。

### 6.2 登录命令

- `/login_device`：为当前 `auth.json` 发起 ChatGPT 设备码登录，FoxClaw 会返回登录 URL、短码、login id 和取消命令。
- `/login_cancel [id]`：取消一个进行中的设备码登录。
- `/logout confirm`：退出当前 Codex 登录。
- `/auth add <name>`：新增一个候选账号，例如 `/auth add work` 会创建 `auth.json_work` 并发起设备码登录。

`/auth add <name>` 的流程：

1. FoxClaw 准备 `auth.json_<name>`。
2. 临时把当前 `auth.json` 指向这个候选。
3. 重启 app-server，让 Codex 写入新候选。
4. 返回登录 URL 和短码。
5. 你在浏览器里完成登录。
6. 成功后，这个候选会出现在 `/auth` 面板里。

如果取消或失败，FoxClaw 会尽量恢复之前的 auth 指向，并删除未完成的新候选。

### 6.3 `/auth` 面板

`/auth` 会列出候选账号、当前账号和 auth 目录，并提供按钮切换、禁用、登录和重载。

示意：

```text
Codex auth
Current: auth.json_personal
Auth dir: /home/alice/.codex
Candidates: 2
1. auth.json_personal * [enabled]
2. auth.json_team [enabled]

[✅ auth.json_personal] [✅]
[🔐 auth.json_team]     [✅]
[🛡️ Access]             [🔑 设备登录]
[🔄 Reload auth]
```

右侧 `✅` / `⏸️` 表示当前状态。点一下会切换启用/禁用，列表刷新后图标会随状态变化。

命令等价用法：

- `/auth` 或 `/auth list`：查看候选。
- `/auth use <n>`：切到第 n 个候选并重启 app-server。
- `/auth enable <n>`：让第 n 个候选参与自动轮转。
- `/auth disable <n>`：禁用第 n 个候选，自动轮转会跳过它。
- `/auth reload` 或 `/auth_reload`：重启 app-server，重新加载当前 `auth.json`。

切换 auth 时，如果当前还有活跃 turn、待审批、待用户输入或 MCP elicitation，FoxClaw 会先拒绝切换，避免中途换号破坏正在进行的请求。

### 6.4 自动轮转如何工作

当 Codex 返回用量限制、未登录、认证失效或类似 auth 错误时，FoxClaw 会尝试自动轮转：

1. 记录当前失败的候选。
2. 从候选列表里选择下一个已启用、还没在本次重试中失败的账号。
3. 把 `auth.json` 指向这个候选。
4. 重启 `codex app-server`，让新认证生效。
5. 用新账号重试刚才失败的请求。

禁用的候选不会参与轮转。如果没有可用候选，FoxClaw 会把错误发回手机，并停止自动重试。

适合的账号组织方式：

```text
auth.json_personal     # 主账号
auth.json_team         # Team 或工作账号
auth.json_plus_trial   # 试用账号
auth.json_backup       # 备用账号，可按需 enable/disable
```

## 7. 一个典型日常流程

1. 在电脑上进入项目目录，确保 Codex 能运行。
2. 手机给 bot 发 `/new /home/alice/Projects/app`，或先 `/threads` 再打开已有线程。
3. 用 `/setup` 选择模型、effort、权限和 Agent/Plan 模式。
4. 发送任务，例如“修掉 failing test，并跑相关测试”。
5. 离开电脑后，用手机看实时进展。
6. 有命令或文件修改审批时，在手机上点批准、拒绝或本次会话允许。
7. 需要观察电脑上 CLI 启动的任务时，用 `/threads` 找到线程，再点 `👀` 或发 `/watch <n>`。
8. 额度到限制时，让 `/auth` 候选自动轮转，或手动 `/auth use <n>`。

## 8. 安全建议

- 不要把 `TG_BOT_TOKEN`、`~/.codex/auth.json*` 或 `.env` 发给别人。
- 第一次不要把 `DEFAULT_CWD` 设成 `/`、`/home`、`/Users` 或整个 home。
- 不确定权限时，用 `/permissions read-only` 或 `/setup` 选 `Read-only`。
- 群组模式只允许配置的 `TG_ALLOWED_USER_ID` 操作，但仍建议只放进可信群。
- 多账号文件里是 Codex 登录凭据，备份和同步时按敏感文件处理。

## 9. 后续阅读

- [新手安装指南](./install-for-beginners.md)
- [Agent 辅助安装](./agent-assisted-install.md)
- [故障排查](./troubleshooting.md)
