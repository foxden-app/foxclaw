# 跨节点 auth 同步配置指南

本指南面向“多台自己控制的机器使用同一组合法 ChatGPT auth 候选”的场景。它把同一节点内的 auth 镜像扩展到跨机器：某台机器上的 Codex 自动刷新出新 token 后，FoxClaw 可以通过 Telegram Bot-to-Bot 私聊把加密 auth 包同步给其他节点；某台机器发现本地候选不可用时，也可以向 peer 拉取它已经持有的有效副本。

这个功能默认关闭。它不需要公网 IP、FRP 或反向代理，但需要 Telegram Bot-to-Bot Communication Mode。

## 适用边界

适合：

- 这些 ChatGPT 账号和 auth 文件都由你合法拥有和维护。
- 多台机器都运行 FoxClaw，并且每台机器至少有一个 Telegram bot。
- 你希望 auth 文件在节点间自动保持较新，并允许 FoxClaw 在已启用 ChatGPT 候选 `last_refresh` 超过 9 天时，持有跨节点刷新锁后主动刷新。
- 默认推荐每台机器只选择一个“联系人 bot”参与跨节点同步；同一节点内其他 bot 继续使用原本的本机 auth 镜像。

不适合：

- 同步来源不可信、账号来源不合法，或你无法确认每台机器的管理员。
- 希望在没有跨节点锁、节点忙碌或候选被禁用时仍强制做 refresh token 保活。
- 同一个 bot token 被多台机器同时 polling；这会破坏 Telegram update 分发和 FoxClaw 的运行假设。

## 设计与安全模型

跨节点同步使用“主动 push + 主动 pull + 跨节点刷新锁”三段互补：

- **Push**：本节点登录、Codex 自动刷新或 `/auth refresh all confirm` 成功并通过本机 usage 验证后，把较新的候选加密发送给 peer。
- **Pull**：本节点切换或重载 auth 前，如果本机其他 runtime 没有更新副本，会向 peer 请求同名、同账号的较新候选。
- **Lease**：执行会旋转 refresh token 的 `/auth refresh all confirm` 或后台 9 天主动刷新前，先向 peer 申请跨节点刷新锁；任一 peer 忙碌、拒绝或无响应都会阻止刷新。

安全边界：

- Telegram 只承载密文。候选文件内容、候选名、account id 和 `last_refresh` 都在 AES-256-GCM payload 内。
- 只接收 `AUTH_SYNC_PEERS` 中列出的 peer bot 发来的同步文件。
- `AUTH_SYNC_KEY`、cluster、nonce 或 payload 校验失败时不会写盘。
- 远端导入必须等本机全局空闲，再临时验证 usage；验证成功后才写入候选。
- 同名候选如果已知属于不同 account id，或属于同一 account 下不同的可识别 ChatGPT 用户/邮箱，永远拒绝覆盖。
- 同步包不会触发自动回复链路；FoxClaw 对包类型、nonce 和 peer allowlist 做过滤，避免 bot-to-bot 循环。

Telegram 官方 Bot Features 文档说明：私聊 bot-to-bot 需要发送方和接收方都启用 Bot-to-Bot Communication Mode，并提醒开发者处理 loop prevention。参考：https://core.telegram.org/bots/features#bot-to-bot-communication

## 配置前准备

假设有两台机器：

- 节点 A：bot `@foxclaw_node_a_bot`
- 节点 B：bot `@foxclaw_node_b_bot`

这两个 bot 就是两个节点的联系人。`AUTH_SYNC_PEERS` 只需要写 peer 节点的联系人 bot，不需要把同一台机器上的所有 bot 都互相列进去。多 bot 模式下，FoxClaw 默认使用 `TG_BOT_TOKENS` 里的第一个 token 作为本节点联系人；如果你希望 5 号 bot 当联系人，就把 5 号 token 放到 `TG_BOT_TOKENS` 第一位，或者给全部 bot 都开启 Bot-to-Bot 作为临时兜底。

每个节点都应该先能独立使用 FoxClaw：

```bash
foxclaw doctor
foxclaw start
```

并且你能分别在 Telegram 私聊两个 bot，执行：

```text
/status
/auth
```

## 在 @BotFather 开启 Bot-to-Bot

对参与同步的每一个 bot 都做一遍：

1. 建议使用最新版 Telegram 手机客户端；部分桌面端或旧客户端看不到这个开关。
2. 打开 `https://t.me/BotFather?startapp`，或进入 `@BotFather` 资料页后点击 **Open App / 打开应用**。
3. 在 BotFather MiniApp 中选择要参与同步的联系人 bot。
4. 进入 Settings / Bot Settings。
5. 找到 **Bot-to-Bot Communication Mode**。
6. 启用该开关。
7. 对所有节点的联系人 bot 重复以上步骤。

不要走 `/mybots` → Bot Settings → **Configure Mini App**。那是配置你自己 bot 的 Mini App URL，不是 Bot-to-Bot Communication Mode。

私聊跨节点同步要求双方都开启这个模式。只开一个通常不足以让两个 bot 互相私聊传输同步包。

如果你看到 `Bad Request: USER_BOT_TO_BOT_DISABLED`，优先确认两件事：发送方联系人 bot 和接收方联系人 bot 都已经开启 Bot-to-Bot；多 bot 模式下，发送方联系人默认是 `TG_BOT_TOKENS` 的第一个 token，不一定是你当前输入命令的 bot。

## .env 配置

两台机器使用相同的 `AUTH_SYNC_KEY` 和 `AUTH_SYNC_CLUSTER_ID`，但 `AUTH_SYNC_NODE_ID` 必须不同。

节点 A：

```dotenv
TG_BOT_TOKENS=<node-a-contact-token>,<node-a-other-bot-token>
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<至少32字节的共享密钥>
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
AUTH_SYNC_NODE_ID=workstation-a
AUTH_SYNC_PEERS=@foxclaw_node_b_bot
```

节点 B：

```dotenv
TG_BOT_TOKENS=<node-b-contact-token>,<node-b-other-bot-token>
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<至少32字节的共享密钥>
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
AUTH_SYNC_NODE_ID=workstation-b
AUTH_SYNC_PEERS=@foxclaw_node_a_bot
```

多节点时，`AUTH_SYNC_PEERS` 用英文逗号分隔：

```dotenv
AUTH_SYNC_PEERS=@foxclaw_node_a_bot,@foxclaw_node_b_bot,@foxclaw_node_c_bot
```

建议用密码管理器或 `openssl` 生成共享密钥：

```bash
openssl rand -base64 32
```

改完配置后重启每台机器的 FoxClaw：

```bash
foxclaw restart
```

## 验证步骤

1. 在每台节点的 bot 私聊里执行：

```text
/auth sync status
```

应能看到 node id、peer 列表和 pending imports。

2. 在节点 A 执行：

```text
/auth sync test
```

节点 A 应提示已向 peer 发送测试 ping。节点 B 的 `/auth sync status` 应能看到最近收到的同步事件或测试状态变化。

从 0.4.17 起，`/auth sync test` 会等待 peer 返回加密 pong。正常结果应该类似：

```text
auth sync 测试完成：已发送 1，收到回应 1。
```

如果显示 `未回应：@peer_bot`，说明 Telegram 发送可能成功，但对方没有成功接收、解密、通过 allowlist，或没有运行同一组 auth sync 配置。

3. 用低风险候选做第一次广播。先确认所有 bot runtime 空闲，然后在节点 A 执行：

```text
/auth sync push all
```

4. 在节点 B 执行：

```text
/auth sync status
/auth
```

确认待导入清单被处理，或候选已经出现/更新时间变新。

注意：`/auth sync push all` 的“已发送”只代表本节点把加密包发给 Telegram 成功，不代表对端已经写盘。对端只有在全局空闲、usage 验证通过、同名候选 account id 一致且 ChatGPT 用户/邮箱身份兼容，并且远端 `last_refresh` 比本地更新时才会覆盖文件。如果本地已经是相同或更新版本，文件不会变化，`最近导入` 也可能保持为空。

启用跨节点同步后，联系人 bot 的私聊会收到节点级通知：本机 auth 更新并开始发往哪些 peer、收到远端包后是排队还是立即验证、导入成功/跳过/失败原因、auth 恢复时正在查询哪些 peer、peer 回应了什么，以及所有 peer 都无法提供可用副本时的人工介入提示。刷新、发送、导入密集发生时会合并成简短汇总，避免一个候选更新拆成开始、收到、镜像写入和完成多条消息；恢复和人工介入提示仍会明确发出。远端导入验证会临时重启本机 Codex app-server；这段窗口里 FoxClaw 会把 runtime 视为非空闲，并让普通消息稍后重发，而不是送进正在重启的 bridge。通知不会包含 auth 内容、token 或同步密文。

从 0.5.2 起，`/auth sync status` 会把同步系统级 `最近错误` 和单个 auth 的 `候选失败` 分开显示。比如某个远端候选返回 `token_invalidated` 或 access token 过期时，只会记录到该候选名下面；当前 `auth.json` 是否健康仍以当前 auth 的 usage 验证为准。`local candidate is already newer or equal` 属于正常跳过，不会记为错误。

手动 `/auth` 切换和 `/auth reload` 只会尝试同节点本地 mirror 恢复，不会主动向跨节点 peer 发起 pull。只有 FoxClaw 检测到当前 auth 真的出现认证问题并进入自动恢复时，才会向 peer 查询可用副本。恢复超时通知会包含 request id、候选名、peer 列表和等待时长；如果等待期间收到过同 peer 的其他 auth sync 消息，通知会标明 peer 可达但该请求超时。

从 0.5.8 起，`/auth sync status` 还会显示 peer 最近活跃时间和最近同步事件。`/auth sync events [过滤]` 可按候选名、peer、request id、事件类型、阶段或详情搜索近期事件。通知里带 request id 时，可用 `/auth sync trace <requestId>` 查看该请求最近的发送、接收和处理结果。

如果升级或重启正好打断远端候选 usage 验证，旧版本可能留下 `auth.json -> .auth-sync-validate-*` 临时 symlink。0.5.2 起 FoxClaw 启动时会自动检测并恢复到 mirror 状态记录的候选，或同目录最近修改且可解析的真实 `auth.json_*` 候选，然后清理临时文件。

5. 只有在完全理解 refresh token 轮换风险时，才测试：

```text
/auth refresh all
/auth refresh all confirm
```

启用跨节点同步后，这个命令会先申请跨节点刷新锁。任一 peer 忙碌、拒绝或超时都会阻止刷新。

## 常见问题

**`/auth sync test` 没反应**

- 确认两个 bot 都已在 `@BotFather` 开启 Bot-to-Bot Communication Mode。
- 确认 `AUTH_SYNC_PEERS` 写的是 peer 的 `@username`，不是 token。
- 确认两边 `AUTH_SYNC_KEY` 和 `AUTH_SYNC_CLUSTER_ID` 完全一致。
- 确认两个节点都重启过 FoxClaw。

**收到同步包但没有写入候选**

- 本机可能不是全局空闲；有 turn、审批、待输入、登录流程或镜像写入时会排队。
- usage 验证失败会拒绝写盘。
- 同名候选属于不同 account id，或属于同一 account 下不同的可识别 ChatGPT 用户/邮箱时会拒绝覆盖。
- 执行 `/auth sync events <候选名>` 或 `/auth sync trace <requestId>`，查看 FoxClaw 记录的接收、验证、跳过或失败流水。

**要不要定期 `/auth refresh all confirm` 保活**

不要手动定期强刷。Codex 会按 access token 到期自动刷新；FoxClaw 也会在已启用 ChatGPT 候选 `last_refresh` 超过 9 天时，等全局空闲并拿到跨节点刷新锁后主动刷新。`/auth refresh all confirm` 仍然是人工维护命令，用于你明确接受 refresh token 轮换风险的场景。
