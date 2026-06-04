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

### 1.1 安装 Node.js 24+

FoxClaw 需要 Node.js 24+，不强依赖 nvm。先检查：

```bash
node -v
```

如果不是 `v24...` 或更高版本，可以用 nvm、fnm、asdf、mise、Volta、Homebrew 或系统包管理器安装 Node 24+。下面是 nvm 示例：

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

`foxclaw init` 会创建默认配置文件 `~/.foxclaw/.env`，并提示填写一个或多个 Telegram bot token（逗号分隔）、Telegram 数字用户 ID 和默认工作目录。如果当前 shell 里有 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等代理变量，它也会询问是否写入 FoxClaw 配置。配置了 `HTTP_PROXY` 或 `HTTPS_PROXY` 后，FoxClaw 会在安装服务时显式传给 systemd/launchd，并启用 Node 的 env proxy。任何一项都可以直接回车跳过，之后再手动编辑：

```bash
$EDITOR ~/.foxclaw/.env
```

第一次私聊模式的最小配置：

```dotenv
TG_BOT_TOKENS=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

字段说明：

- `TG_BOT_TOKENS`：从 `@BotFather` 拿到的一个或多个 bot token，多项用英文逗号分隔。旧版单 bot 配置 `TG_BOT_TOKEN` 仍兼容；多 bot 模式下，如果 `TG_BOT_TOKEN` 的值也出现在 `TG_BOT_TOKENS` 中，匹配的 bot 会使用默认/终端共享 runtime。
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

后续升级只需运行 `foxclaw update`；它会使用当前安装 FoxClaw 的 npm 或 pnpm，尝试同时升级由 npm/pnpm 全局安装的 Codex CLI，然后执行自检并重启后台服务。

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

### 3.2 `/status`、`/account`、`/quota`、`/update`

- `/status`：查看 FoxClaw、app-server、当前绑定线程、模型、权限和 Codex 用量摘要。多 bot 模式还会列出所有 bot 的连接、当前 auth、活动 turn，以及最近一次 auth 镜像和服务/Codex 升级结果。本地 session/Token/可见答复吞吐使用后台生成的历史快照，避免状态查询现场扫描大量日志；答复吞吐按完成轮次端到端耗时计算，排除推理 token，但包含等待与工具执行时间。
- `/account`：查看当前 Codex 登录账号。
- `/quota`：查看 Codex 用量和额度窗口。
- `/update`：升级 FoxClaw，并尝试升级 npm/pnpm 安装的 Codex CLI，然后自检和重启服务；任意 Telegram bot、启用的微信默认 runtime 或 auth 镜像写入不空闲时都会拒绝执行，重启后通过发起命令的 bot 回报 FoxClaw 与 Codex CLI 的版本变化。

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

这是 FoxClaw 的特色功能。Codex 的登录状态通常保存在 `~/.codex/auth.json`。FoxClaw 把多个账号保存成候选文件，并通过切换 `auth.json` 指向哪个候选来换号。启用 `TG_BOT_TOKENS` 多 bot 模式后，默认每个 bot 使用独立 Codex home、独立 app-server 和独立当前候选，因此可以并行运行、单独切号；隔离 Telegram runtime 会强制使用文件凭据存储。已验证的登录/刷新凭据会安全镜像到其他 bot home，但不会共享 session。

如果你想保留一路和终端互通 session 的 Telegram bot，把该 token 同时写入 `TG_BOT_TOKENS` 和 `TG_BOT_TOKEN`。这个 bot 使用默认 `CODEX_HOME` 和默认 auth，因此能看到终端 Codex 的本地线程；它的 `/auth` 切换也会影响终端默认 auth。其他只出现在 `TG_BOT_TOKENS` 的 bot 仍然完全隔离。

### 6.1 文件格式

单 bot 兼容模式的候选文件放在 Codex auth 目录，默认是 `~/.codex/`。如果你设置了 `CODEX_AUTH_DIR`，则使用那个目录。多 bot 模式以这个目录作为候选源，并在 `~/.foxclaw/codex/telegram/bot<id>/home/` 下为隔离 bot 保存副本。默认/终端共享 bot 不创建隔离副本，而是直接使用这个默认 auth 目录。

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

`auth.json` 是 Codex 当前使用的文件。切换账号时，FoxClaw 会把 `auth.json` 指向某个候选文件。候选文件内容是 Codex CLI 生成的 JSON，不建议手写这些字段。多 bot 镜像只在账号标识一致、刷新时间更新，并且由当前 app-server 通过 ChatGPT 用量接口在线验证时复制候选，避免同名候选意外覆盖成另一个账号。切换或重载 auth 之前，FoxClaw 还会在其他 Codex home 中查找同账号 ID 的较新凭据，先恢复到发起操作的 runtime，再在重启后验证并镜像。

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

`/auth` 会列出候选账号、当前账号和 auth 目录，并提供按钮切换、禁用、登录和重载。多 bot 模式中，面板顶部还会显示当前正在管理的 `@botname`，因为该 bot 内的私聊、群聊和话题共享同一个当前 auth。面板每页显示 8 个候选，支持翻页、`全部 / 已启用 / 需关注` 筛选和 `/auth list <关键词>` 文件名搜索，适合管理较大的本地候选清单。面板文本和按钮会省略标准候选文件名中重复的 `auth.json_` 前缀，例如磁盘上的 `auth.json_personal` 显示为 `personal`；文件本身不会重命名，搜索和命令仍按原候选工作。命令 `/auth use <n>` 的编号始终对应完整候选列表，不会因为分页变化。

文本列表中每个候选名前的 `窗口:剩余百分比` 来自最近一次观察到的真实额度窗口，例如 Plus 账号可能显示 `5h:20|7d:25`，只有一个月度窗口的账号可能显示 `30d:97`。按钮为了适配窄屏，只显示两个剩余百分比数字，例如 `20|25`；未知值显示为 `—`。当前 auth 会在打开面板时刷新额度；其他候选不会为了查询额度被自动切换。如果多个 bot runtime 最近使用过同一个 ChatGPT 账号，FoxClaw 会按已验证的账号 ID 合并它们缓存到的额度快照，因此一个 bot 的 `/auth` 面板可以显示另一个 bot 掌握到的额度信息，同时不会把不同账号混在一起。

示意：

```text
Codex auth
Current: personal
Auth dir: /home/alice/.codex
Candidates: 2
额度剩余：窗口:百分比|auth
1. 5h:20|7d:25|personal * [Plus · 正常 · 刷新于 2小时前]
2. --|team [额度未知]

[✅ 20|25|personal] [✅]
[🔐 —|—|team]       [✅]
[☑️ 全部] [已启用] [需关注]
[🛡️ Access]             [🔑 设备登录]
[🔄 Reload auth]
```

右侧 `✅` / `⏸️` 表示当前是否参与自动轮转。点一下会切换启用/禁用，列表刷新后图标会随状态变化。点击候选会切换 auth、重启对应 runtime，并在原消息上刷新面板且保留按钮，因此可以立即连续切换。`--` 表示该候选还没有额度历史快照。健康摘要会区分正常、额度偏低、额度耗尽、额度未知、长期未刷新、API key 和无效 auth 文件。

`/auth refresh all` 是仅命令入口的维护操作，因为 ChatGPT refresh token 会被轮换。只有所有 Telegram runtime、微信 runtime、审批、待输入、登录流程和 auth 镜像写入都空闲时才允许执行。命令会先显示风险确认：如果 OpenAI/Codex 已经消费旧 refresh token，但因为网络、进程或磁盘故障导致新 token 没能成功保存，该候选可能需要重新设备登录，甚至重新手机号验证。确认后，它会逐个访问 ChatGPT 候选，让 Codex 通过 `account/read refreshToken=true` 强制刷新 token，再用 usage 接口验证，成功后镜像到其他 bot home，最后恢复原本的当前 auth 并显示摘要。

OpenAI 没有公开 ChatGPT refresh token 的固定有效期或旧 token 重放宽限期。Codex 会在 access token 临近到期时自动刷新；如果 access token 里无法解析 `exp`，Codex 当前使用 `last_refresh` 超过约 8 天作为兜底刷新条件。面板把超过 8 天没有刷新记录的候选标为“长期未刷新”，但这只是维护提醒，不代表 refresh token 已经过期，也不会触发批量保活刷新。不要把 `/auth refresh all` 当作日常保活命令。

### 6.4 跨节点 auth 同步

跨节点 auth 同步默认关闭。它适合你在多台自己控制的机器上使用同一组合法 ChatGPT 账号候选，并希望某台机器上 Codex 自动刷新出的新 token 能同步到其他机器。v1 使用 Telegram Bot-to-Bot 私聊传输加密文件，不需要公网 IP 或 FRP；需要先在 BotFather 为参与同步的 bot 开启 Bot-to-Bot Communication Mode。

完整设计、安全边界、`.env` 示例和排查步骤见 [跨节点 auth 同步配置指南](./cross-node-auth-sync.md)。

在 `@BotFather` 中对每个参与同步的 bot 执行：

1. 打开 `@BotFather`。
2. 发送 `/mybots`。
3. 选择参与同步的 bot。
4. 打开 bot settings / Mini App 设置界面。
5. 找到并启用 **Bot-to-Bot Communication Mode**。
6. 对所有 peer bot 重复；私聊同步要求发送方和接收方都开启。

配置示例：

```dotenv
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<至少32字节的共享密钥>
AUTH_SYNC_PEERS=@other_node_bot,@third_node_bot
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
# 可选；不填时 FoxClaw 会生成并持久化本机 node id
AUTH_SYNC_NODE_ID=workstation-a
```

安全边界：

- Telegram 只承载密文；auth 文件内容、候选名、account id、`last_refresh` 都在 AES-256-GCM 加密 payload 内。
- 只接收 `AUTH_SYNC_PEERS` 中 peer bot 发来的同步文件；密钥、cluster、nonce 或 payload 校验失败时不会写盘。
- 远端导入必须等本机全局空闲，再临时切换到待验证 auth、重启 app-server、读取 usage 验证成功后才写入候选。
- 同名候选如果已知属于不同 account id，永远拒绝覆盖。
- 跨节点恢复只拉取 peer 已持有的有效副本，不会自动触发 refresh token 轮换；找不到有效副本时会停止，提示你在一个节点手动维护授权。

双主动流程：

- push：本节点登录、Codex 自动刷新或 `/auth refresh all` 成功并通过本机镜像验证后，会主动把较新的候选加密推送给 peer。
- pull：本节点切换或重载 auth 前如果发现本地候选不是最新，会先查本机其他 runtime；仍找不到时，再向 peer 拉取同名同账号的较新副本。
- lease：执行会旋转 refresh token 的 `/auth refresh all confirm` 前，会向 peer 申请跨节点刷新锁。任一 peer 忙碌、拒绝或无响应都会阻止刷新。

命令：

- `/auth sync status`：查看 node id、peer、最近收发、最近导入、待导入和最近错误。
- `/auth sync test`：发送加密 ping，确认 peer、共享密钥和 Bot-to-Bot 私聊可用。
- `/auth sync push all`：手动广播当前节点已验证的全部候选，不刷新 token。

命令等价用法：

- `/auth` 或 `/auth list [关键词]`：查看候选，可按文件名搜索。
- `/auth filter <all|enabled|attention>`：筛选全部、已启用或需关注候选。
- `/auth page <页码>`：直接查看指定页。
- `/auth use <n>`：切到第 n 个候选并重启 app-server。
- `/auth enable <n>`：让第 n 个候选参与自动轮转。
- `/auth disable <n>`：禁用第 n 个候选，自动轮转会跳过它。
- `/auth reload` 或 `/auth_reload`：重启 app-server，重新加载当前 `auth.json`。
- `/auth refresh all`：显示 refresh token 轮换风险确认。
- `/auth refresh all confirm`：接受 token 轮换风险后执行刷新全部。
- `/auth sync status|test|push all`：查看、测试或手动推送跨节点 auth 同步。

切换 auth 时，如果当前 bot runtime 还有活跃 turn、待审批、待用户输入或 MCP elicitation，FoxClaw 会先拒绝切换，避免中途换号破坏正在进行的请求；另一个空闲 bot 不受影响。

### 6.5 自动轮转如何工作

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

- 不要把 `TG_BOT_TOKENS`、`TG_BOT_TOKEN`、`~/.codex/auth.json*` 或 `.env` 发给别人。
- 第一次不要把 `DEFAULT_CWD` 设成 `/`、`/home`、`/Users` 或整个 home。
- 不确定权限时，用 `/permissions read-only` 或 `/setup` 选 `Read-only`。
- 群组模式只允许配置的 `TG_ALLOWED_USER_ID` 操作，但仍建议只放进可信群。
- 多账号文件里是 Codex 登录凭据，备份和同步时按敏感文件处理。

## 9. 后续阅读

- [新手安装指南](./install-for-beginners.md)
- [Agent 辅助安装](./agent-assisted-install.md)
- [跨节点 auth 同步配置指南](./cross-node-auth-sync.md)
- [故障排查](./troubleshooting.md)
