# 跨节点 auth 同步配置指南

本指南面向“多台自己控制的机器使用同一组合法 ChatGPT auth 候选”的场景。它把同一节点内的 auth 镜像扩展到跨机器：某台机器上的 Codex 自动刷新出新 token 后，FoxClaw 可以通过 Telegram Bot-to-Bot 私聊把加密 auth 包同步给其他节点；某台机器发现本地候选不可用时，也可以向 peer 拉取它已经持有的有效副本。

这个功能默认关闭。它不需要公网 IP、FRP 或反向代理，但需要 Telegram Bot-to-Bot Communication Mode。

## 适用边界

适合：

- 这些 ChatGPT 账号和 auth 文件都由你合法拥有和维护。
- 多台机器都运行 FoxClaw，并且每台机器至少有一个 Telegram bot。
- 你希望 auth 文件在节点间自动保持较新，但不希望日常主动旋转 refresh token。

不适合：

- 同步来源不可信、账号来源不合法，或你无法确认每台机器的管理员。
- 希望用 `/auth refresh all` 当作 refresh token 保活工具。
- 同一个 bot token 被多台机器同时 polling；这会破坏 Telegram update 分发和 FoxClaw 的运行假设。

## 设计与安全模型

跨节点同步使用“主动 push + 主动 pull + 跨节点刷新锁”三段互补：

- **Push**：本节点登录、Codex 自动刷新或 `/auth refresh all confirm` 成功并通过本机 usage 验证后，把较新的候选加密发送给 peer。
- **Pull**：本节点切换或重载 auth 前，如果本机其他 runtime 没有更新副本，会向 peer 请求同名、同账号的较新候选。
- **Lease**：执行会旋转 refresh token 的 `/auth refresh all confirm` 前，先向 peer 申请跨节点刷新锁；任一 peer 忙碌、拒绝或无响应都会阻止刷新。

安全边界：

- Telegram 只承载密文。候选文件内容、候选名、account id 和 `last_refresh` 都在 AES-256-GCM payload 内。
- 只接收 `AUTH_SYNC_PEERS` 中列出的 peer bot 发来的同步文件。
- `AUTH_SYNC_KEY`、cluster、nonce 或 payload 校验失败时不会写盘。
- 远端导入必须等本机全局空闲，再临时验证 usage；验证成功后才写入候选。
- 同名候选如果已知属于不同 account id，永远拒绝覆盖。
- 同步包不会触发自动回复链路；FoxClaw 对包类型、nonce 和 peer allowlist 做过滤，避免 bot-to-bot 循环。

Telegram 官方 Bot Features 文档说明：私聊 bot-to-bot 需要发送方和接收方都启用 Bot-to-Bot Communication Mode，并提醒开发者处理 loop prevention。参考：https://core.telegram.org/bots/features#bot-to-bot-communication

## 配置前准备

假设有两台机器：

- 节点 A：bot `@foxclaw_node_a_bot`
- 节点 B：bot `@foxclaw_node_b_bot`

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

1. 打开 Telegram，进入 `@BotFather`。
2. 发送 `/mybots`。
3. 选择要参与同步的 bot。
4. 打开 BotFather 的 bot settings / Mini App 设置界面。
5. 找到 **Bot-to-Bot Communication Mode**。
6. 启用该开关。
7. 对所有 peer bot 重复以上步骤。

私聊跨节点同步要求双方都开启这个模式。只开一个通常不足以让两个 bot 互相私聊传输同步包。

## .env 配置

两台机器使用相同的 `AUTH_SYNC_KEY` 和 `AUTH_SYNC_CLUSTER_ID`，但 `AUTH_SYNC_NODE_ID` 必须不同。

节点 A：

```dotenv
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<至少32字节的共享密钥>
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
AUTH_SYNC_NODE_ID=workstation-a
AUTH_SYNC_PEERS=@foxclaw_node_b_bot
```

节点 B：

```dotenv
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
- 同名候选属于不同 account id 时会拒绝覆盖。

**要不要定期 `/auth refresh all confirm` 保活**

不要。Codex 会按 access token 到期自动刷新。FoxClaw 的跨节点同步会同步“已经成功刷新的新 auth”，不应该把 refresh all 当作日常保活。

