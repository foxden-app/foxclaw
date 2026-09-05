# 2026-09-05 桥可靠性修复与现场验收

## 现场结论

- 16P 的 Codex 为 0.153.4，查询 npm 得到相同版本。真实 app-server 模型列表包含 gpt-6-astra。T490 当前为 0.153.0，也支持 `codex resume --remote`。
- 检查时最近两天日志有 75 次 Telegram polling 错误与 29 次 Codex WebSocket 警告。TLS 断连、明确的 `401 token_revoked`、本地连接状态必须分别判断。
- 旧 RPC 没有截止时间；`/takeover` 无限等待 completion 会一直占用 scope 队列。登录取消先等待 RPC，失败时不清理状态，且完成通知可能抢先触发重复清理。
- 旧 app-server attach 失败会清除仍存活服务的记录，可能另起服务并留下写入锁。外部观察轮次也可能被重连恢复错误地 resume。

## GamsGo2024 同步

时间为北京时间，证据来自 16P 与 T490 的 systemd 日志及只读 SQLite 查询。

- 12:29:45，16P 启动集群审计，request id 为 `6bce5971-d26f-497f-9dbb-bd906fae86a6`。
- T490 收到审计后在 12:30:02 返回报告。
- 12:40:07，T490 的 `auth.mirror.remote_imported` 与 `auth.sync.imported` 明确记录 `auth.json_GamsGo2024` 已导入。
- 12:40:18 的 “local candidate is already newer or equal” 是后续重复推送被跳过，不能据此推断前一次同步失败。
- 最终只读查询显示全局和 6 个 runtime 均为 `active`，未禁用。旧 Telegram 面板保留的是候选快照。
- 16P 原 peer 列表同时含 `@WuguiAI_Bot` 与 `@walma10bot`。两者在 T490 同一桥进程中，统一由第一个 bot 回复，因此后者被视为未回应，导致两轮各 5 分钟的等待。
- 16P 本地配置已去掉重复的 `@walma10bot` peer，保留 `@WuguiAI_Bot` 和 `@walte2026_bot`。T490 仍沿用 `workstation-GJZN` 节点名，本次未重命名或迁移账号。

## 实现

- Codex RPC 30 秒超时，清理 pending，不自动重发结果未知的任务；WebSocket 握手有截止时间。
- Telegram 请求增加总时限与响应流错误处理，避免持续零碎数据或半断连接拖住请求。
- 活动会话断连与恢复失败有明确提示；保留存活但无法连接的 app-server 记录，重连共用启动锁。
- `/takeover` 中断确认等待 30 秒后退出，不会延迟启动替换任务。
- `/status`、`/cli`、`/interrupt`、`/login_cancel` 及只读 auth sync 查询可绕过普通消息队列，仍经过原有权限和目标检查。
- 设备登录、auth add、auth repair 提供取消按钮；本地状态在等待取消响应前认领清理，旧按钮及其他会话无法取消当前登录。
- 新增 `foxclaw resume [thread-id] [--bot-id <bot-id>]` 及 Telegram `/cli`，进入桥正在使用的同一 app-server，避免另起 writer。
- 重连恢复跳过独立 CLI 的只读观察轮次。独立 CLI 的 `/watch` 不增加强抢或删锁行为。
- 新增显式 `/takeover --force <消息>`。仅可信 Telegram 用户可在 60 秒内确认；实现按目标 thread 的真实 flock 定位同用户交互式 CLI，通过 pidfd 防 PID 复用，拒绝 app-server、远程客户端、桥祖先进程及持有多个 thread 的进程。先 SIGTERM，5 秒后仍存活才 SIGKILL；只有锁已释放且原 thread 恢复成功后才提交消息。不会删除锁、修改 session 文件或自动重试结果未知的提交。
- 点击旧问号、登录修复或删除按钮前重读授权状态，已恢复时刷新面板。
- 同步文案明确“已发送、远端导入未确认”；状态更新未满足身份/时间约束时记录 `skipped`。

## 验证与部署

- 稳定版全量测试共 421 项：420 项通过，1 项因当前进程环境没有 OpenCode CLI 按既有条件跳过；此前带 OpenCode 环境的预览验收为 421 项全部通过。另有 8 项隔离进程测试，覆盖真实 flock、pidfd、SIGTERM/SIGKILL、PID 身份变化和不安全进程拒绝。typecheck、lint、build、diff check 通过。
- 新增回归覆盖 RPC 超时后的迟到响应、不重发、发送失败清理、存活服务记录保护、登录取消失败/竞态/旧按钮、中断超时不延迟发送、观察轮次不获取 writer、旧授权面板刷新、审计状态跳过、Telegram 流式拖延总超时、多 bot CLI 路由。
- 在独立临时 CODEX_HOME 中启动真实 Codex 0.153.4，两个客户端连接同一个 app-server 并 resume 同一个已有记录的 thread，验证同线程、同服务。测试不使用用户授权，不调用模型完成任务。空线程在产生记录前不能 resume。
- 预览安装包最终为 `/tmp/foxden-app-foxclaw-0.7.3-dev.3.tgz`。16P 使用 npm 安装，T490 使用其 pnpm 安装并更新 systemd 到实际包路径。
- 重启前确认两端桥内无活动任务，并通过只读 `thread/loaded/list` 确认所有受管 app-server 均无加载线程。
- 16P 与 T490 实际 runtime userAgent 均包含 `foxclaw; 0.7.3-dev.3`；两端 systemd active/running、NRestarts=0、ExecMainStatus=0。T490 六个 bot 均 connected=true。
- 真实强制接管验收中，目标 thread `01a06fd3-668d-7c81-96e1-d6394c2cf782`、PID `289937`、工作目录 `/home/wuya/git/foxclaw` 经用户确认后停止；日志记录 `codex.external_writer_stopped`。随后同一 thread 由桥的 app-server 持锁并启动新 turn，未删除锁文件。
- 调用真实 Telegram `getMyCommands`：16P 中英文菜单、T490 同步联系人与 walma10bot 中文菜单均包含 `login_cancel` 和 `cli`。

## 剩余边界

- 本报告先记录本地预览与真实接管验收；正式 npm 和 GitHub Release 状态以发布后的 registry/workflow 验证为准。
- 没有代用户执行真实登录和 Telegram 按钮点击；按钮行为由回归测试验证，菜单已通过真实 Telegram API 验收。
- 去重后未再次触发整个集群的安全同步；原同步导入结果和去重后的运行配置已核实。
- 网络完全断开时无法即时发送 Telegram 错误提示，可使用本机 `foxclaw resume`。底层服务完全失联时需检查 `foxclaw status`；重启应确认其他会话空闲。
- 其他候选仍有过期或明确 revoked 的错误，不能视为本次 GamsGo2024 修复失败，也不能通过无条件覆盖或反复刷新解决。
