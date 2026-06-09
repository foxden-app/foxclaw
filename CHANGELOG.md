# Changelog

All notable FoxClaw changes are listed here. Each release note is bilingual so GitHub Releases and the npm package are useful to both Chinese and English readers.

## 0.5.31 - 2026-06-09

### 中文
- 修复自动 auth 轮转：目标候选切换后如果在 account/usage 验证阶段失败，会把该候选加入本次失败集合并继续轮询后续候选，而不是恢复原 auth 后停止。
- 新增回归测试覆盖候选池中间账号验证失败时继续切到下一个可用账号并重试原请求。

### English
- Fixed automatic auth rotation so a candidate that fails account/usage validation after switching is added to the current failure set and FoxClaw keeps polling later candidates instead of stopping after restoring the previous auth.
- Added regression coverage for continuing to the next usable account and retrying the original request when a middle candidate fails validation.

## 0.5.30 - 2026-06-09

### 中文
- 修正重启自动续接路径：自动恢复现在会先像用户手动发送“继续”一样 `resumeThread` 原 Codex thread，再在原 thread 上启动续接 turn。
- 如果原 thread 暂时无法恢复，FoxClaw 会保留状态卡并重试；不会静默切到 replacement thread，避免丢失原线程上下文。

### English
- Fixed restart auto-resume to match the manual "continue" path: FoxClaw now resumes the original Codex thread first, then starts the continuation turn on that same thread.
- If the original thread cannot be resumed yet, FoxClaw keeps the status card and retries instead of silently switching to a replacement thread and losing context.

## 0.5.29 - 2026-06-09

### 中文
- 重启自动续接遇到旧 Codex thread 永久 `thread not found` 时，会静默创建 replacement thread 并复用原 Telegram 状态卡继续跑，不再只反复等待旧 thread 恢复。
- 自动续接提示补充了无上下文兜底指令：如果旧线程上下文不可用，会检查当前工作目录、git 状态、服务日志和运行状态后完成收尾总结。

### English
- Restart auto-resume now silently creates a replacement thread when the old Codex thread remains `thread not found`, reusing the original Telegram status card instead of only waiting for the old thread to recover.
- The auto-resume prompt now includes a no-context fallback: inspect the current working directory, git status, service logs, and runtime state before finishing the user-facing summary.

## 0.5.28 - 2026-06-09

### 中文
- 重启续接恢复失败时不再立刻把 Telegram 状态卡改成“桥接重启、请手动继续”；FoxClaw 会保留 active preview 并在后台短间隔重试几分钟。
- 这修复了 Codex app-server 刚重启时线程短暂 `thread not found`，导致自动续跑错过窗口、没有最终总结消息的问题。

### English
- Restart recovery no longer immediately retires the Telegram status card as "bridge restarted, continue manually" when the first recovery attempt fails. FoxClaw keeps the active preview and retries in the background for several minutes.
- This fixes cases where the Codex app-server briefly reports `thread not found` right after restart, causing auto-resume to miss its window and never send the final summary.

## 0.5.27 - 2026-06-09

### 中文
- 重启续接的完成判定进一步收窄：只有 final/final_answer 类 assistant 输出、plan 输出或明确错误才算已有完成结果。
- 如果旧 turn 只有 commentary 进度消息，例如“正在升级本机服务”，重启后仍会自动续跑，避免状态卡显示“已完成”但没有真正收尾回复。

### English
- Tightened restart recovery completion detection: only final/final_answer assistant output, plan output, or an explicit error now counts as a completed result.
- If the previous turn only had commentary progress such as "upgrading the local service", FoxClaw still auto-resumes it after restart instead of retiring the status card as completed without a real final reply.

## 0.5.26 - 2026-06-09

### 中文
- 修正重启续接判定：如果 Codex app-server 把被重启打断的旧 turn 标成 completed，但没有任何可转发的 assistant/plan 输出或错误内容，FoxClaw 会把它当作中断任务自动续跑，而不是把 Telegram 状态卡误改成“已完成”。
- 已经有明确输出或错误结果的 completed turn 仍按完成处理，避免对真实完成的任务重复续跑。

### English
- Fixed restart recovery detection: if the Codex app-server marks a restart-interrupted turn as completed but it has no relayable assistant/plan output or error, FoxClaw now treats it as interrupted and auto-resumes it instead of retiring the Telegram status card as completed.
- Completed turns that do have output or an error are still treated as finished, avoiding duplicate resume runs for truly completed work.

## 0.5.25 - 2026-06-09

### 中文
- FoxClaw 重启后会优先重新接管 Codex app-server 中仍在运行的 live turn，包括 turn id 已变化但线程仍有 live turn 的情况，避免误开第二个续跑任务。
- 如果重启前记录的活动 turn 已被 app-server 中断且没有完成结果，FoxClaw 会自动在同一线程启动一个“继续中断工作”的新 turn，并复用原 Telegram 状态卡继续更新，不再要求用户手动发送“继续”。
- 如果旧 turn 已经完成，FoxClaw 只收尾旧状态卡，不会误触发自动续跑。

### English
- After a FoxClaw restart, live Codex app-server turns are reattached first, including cases where the live turn id changed but the thread still has an active turn, avoiding a duplicate resume turn.
- If the previously tracked active turn was interrupted by the app-server restart and has no completed result, FoxClaw automatically starts a continuation turn in the same thread and reuses the existing Telegram status card.
- If the old turn already completed, FoxClaw only retires the old status card and does not auto-resume it.

## 0.5.24 - 2026-06-09

### 中文
- 后台主动 auth 刷新不再向私聊推送开始、跳过、完成或失败消息；最近一次刷新状态会写入 runtime status，并可在 `/status` 和 `/auth sync status` 主动查看。
- 本机 auth mirror 和跨节点 auth sync 的刷新/导入/同步摘要也默认静默，不再推送 `auth 刷新/同步汇总` 或候选已同步提示，减少后台维护对注意力的打扰。

### English
- Background proactive auth refresh no longer pushes private start, skipped, completed, or failed messages. The latest refresh state is stored in runtime status and can be checked with `/status` and `/auth sync status`.
- Same-node auth mirroring and cross-node auth sync refresh/import/sync summaries are quiet by default, so background maintenance no longer pushes auth refresh/sync summaries or per-candidate synced notices.

## 0.5.23 - 2026-06-09

### 中文
- 补齐切换后验证路径：如果目标候选在验证 rate-limit usage 时返回 usage/rate/quota/billing/credits limit，FoxClaw 会恢复到原 auth，但不会把目标候选标记为 `?`，也不会触发自动剔除。
- 这让额度耗尽在自动轮换、手动切换和验证失败提示里都保持同一语义：它只是暂时没额度，不是凭据失效。

### English
- Completed the post-switch validation path: if the selected candidate returns a usage/rate/quota/billing/credits limit while validating rate-limit usage, FoxClaw restores the previous auth but does not mark the selected candidate `?` or auto-delete it.
- Quota exhaustion now has the same meaning across automatic rotation, manual switching, and validation failure messages: temporarily out of quota, not an invalid credential.

## 0.5.22 - 2026-06-09

### 中文
- Codex 报 `usageLimitExceeded`、`You've hit your usage limit`、usage/rate/quota/billing/credits limit 这类额度耗尽时，不再把当前 auth 候选标记为需要修复，也不会触发 `AUTH_AUTO_DELETE_NEEDS_REPAIR` 的自动剔除和跨节点删除。
- 额度耗尽仍会临时避开当前候选，切到另一个维护中的候选重试；提示文案改为“Codex 额度限制”，不再误写成 “Codex auth 问题”。

### English
- Codex quota exhaustion such as `usageLimitExceeded`, `You've hit your usage limit`, usage/rate/quota/billing/credits limit is no longer treated as an invalid auth candidate, so it does not mark `needs_repair` or trigger `AUTH_AUTO_DELETE_NEEDS_REPAIR` auto-delete / cross-node delete.
- Quota exhaustion still temporarily skips the current candidate and retries with another maintained candidate; notifications now call this a Codex usage limit instead of an auth problem.

## 0.5.21 - 2026-06-09

### 中文
- 新增资源富裕 auth 池模式：`AUTH_AUTO_DELETE_NEEDS_REPAIR=true` 或 `/config auth_auto_delete on` 会把原本要标记为 `?`/需要登录修复、且无法恢复的候选自动剔除。
- 自动剔除会通过跨节点 auth sync 发送删除 tombstone，peer 收到后删除同名候选，并优先处理删除，避免待导入队列把坏候选复活。
- `/status` 和 `/config` 现在显示 auth 池摘要：历史见过的候选数、当前存活数、因失效自动剔除数；`/config` 的开关会写回当前 FoxClaw `.env`。
- 开启自动剔除后，auth mirror / auth sync 的候选级同步、导入、删除和恢复通知会静默或汇总为池子摘要；同步发送/导入失败、删除失败和系统级 `sync_error` 仍会明确提示。

### English
- Added a resource-rich auth pool mode: `AUTH_AUTO_DELETE_NEEDS_REPAIR=true` or `/config auth_auto_delete on` automatically deletes unrecoverable candidates that would otherwise be marked `?` / needs login repair.
- Auto-delete now publishes a cross-node auth-sync delete tombstone, so peers delete the same candidate and process deletes before pending imports to avoid resurrecting bad candidates.
- `/status` and `/config` now show an auth-pool summary: total candidates seen, currently alive, and invalid-deleted count. The `/config` toggle writes back to the active FoxClaw `.env`.
- When auto-delete is enabled, candidate-level auth mirror / auth sync publish, import, delete, and recovery chatter is silenced or collapsed into pool summaries; sync send/import failures, delete failures, and system-level `sync_error` still notify explicitly.

## 0.5.20 - 2026-06-08

### 中文
- 修复跨节点 auth 同步远端导入验证和普通消息并发时的竞态：验证远端候选会临时重启 Codex app-server，现在这段窗口会标记为非空闲。
- 如果普通消息刚好在远端验证重启期间进入，FoxClaw 会提示稍后重发，不再把这条消息送进正在重启的 bridge 并报 `Codex app bridge stopped`。
- 普通对话启动过程现在也计入非空闲状态，避免 auth 同步验证插入到新 turn 建立中的窗口。

### English
- Fixed a race between cross-node auth remote-import validation and ordinary messages. Remote candidate validation temporarily restarts Codex app-server, and that window is now marked non-idle.
- If an ordinary message arrives during the validation restart window, FoxClaw asks the user to resend it shortly instead of sending it into a restarting bridge and reporting `Codex app bridge stopped`.
- Starting an ordinary turn now also counts as non-idle, preventing auth sync validation from entering the small window while a new turn is being established.

## 0.5.19 - 2026-06-08

### 中文
- 主动后台 auth 刷新现在只保留一条私聊状态消息：开始时发送，完成或拿不到刷新锁时编辑为最终结果，减少开始/完成两条消息的打扰。
- 本机 auth 镜像和跨节点 auth 同步的刷新 burst 现在会短窗口汇总，把候选镜像、跨节点发送、收到远端包、导入/跳过/失败合成摘要；恢复失败和人工介入提示仍会明确发出。

### English
- Background proactive auth refresh now keeps one private status message: it sends the starting state and edits that message to the final result or lease failure, reducing separate start/done notifications.
- Same-node auth mirroring and cross-node auth sync now group refresh bursts into short summaries covering mirror writes, peer sends, received remote bundles, import/skip/failure results, while recovery failures and manual-intervention notices remain explicit.

## 0.5.18 - 2026-06-08

### 中文
- `/auth` 面板按钮和 `/auth use <n>` 手动切换后会立即通过 Codex app-server 验证新 auth：ChatGPT 候选必须能返回 account 和 rate-limit usage，成功后马上写入该候选的额度快照，所以列表不再继续显示旧额度。
- 如果切换后的 auth 无法读取、身份不匹配，或 Codex 没有返回有效 account/usage，FoxClaw 会把该候选标记为“需要登录修复”（`?`），恢复到切换前的 auth，并再次重启 Codex app-server，让当前 runtime 不停留在坏 auth 上。
- 自动 auth 轮换也复用同一套切换后验证；验证失败的候选不会继续重试请求或参与后续轮询。

### English
- Manual auth switches from the `/auth` panel buttons and `/auth use <n>` now validate the newly selected auth through Codex app-server immediately. ChatGPT candidates must return account and rate-limit usage, and successful switches record a fresh quota snapshot so the list no longer keeps showing stale usage.
- If the selected auth cannot be parsed, has an identity mismatch, or Codex does not return valid account/usage data, FoxClaw marks that candidate as “needs login repair” (`?`), restores the previous auth, and restarts Codex app-server again so the runtime does not remain on a bad auth.
- Automatic auth rotation now uses the same post-switch validation; failed candidates are not used for retrying the request or for later polling.

## 0.5.17 - 2026-06-08

### 中文
- `foxclaw <subcommand> --help` / `-h` 现在只打印帮助，不再继续执行 `install-systemd`、`start`、`restart` 等带副作用的子命令，避免一次查帮助意外触发服务重启。

### English
- `foxclaw <subcommand> --help` / `-h` now prints usage and stops before running side-effecting subcommands such as `install-systemd`, `start`, or `restart`, preventing an accidental service restart while checking help.

## 0.5.16 - 2026-06-08

### 中文
- FoxClaw 重启后会把仍在运行的桥接自有 Codex turn 恢复为可继续操作的活动态，状态卡继续刷新，后续 Telegram 输入会继续 steer 或按聊天设置排队，不再退化成需要用户重新发消息的只读观察态。
- `/watch` 产生的观察态 turn 会在状态卡中持久化只读标记，重启恢复后仍保持只读，避免把旁观线程误恢复成可操作任务。

### English
- After a FoxClaw restart, bridge-owned live Codex turns are restored as actionable active turns: their status cards keep updating, and later Telegram messages keep steering or queueing according to the chat setting instead of degrading into read-only watch mode.
- `/watch`-created observed turns now persist their read-only marker, so restart recovery keeps watched threads read-only and does not accidentally promote them into actionable tasks.

## 0.5.15 - 2026-06-08

### 中文
- `/auth` 现在会把已确认不可用、并且本机/跨节点同步恢复失败的候选标记为“需要登录修复”，用 `?` 按钮显示，并从自动轮换、主动刷新和 enabled 视图中排除。
- 点击 `?` 会进入修复菜单，可选择“登录修复”对该候选执行设备码登录，成功后清除修复状态并重新参与轮换；也可选择“删除”，从 canonical 和所有本机 bot runtime 中删除该候选并清理额度缓存。
- 删除 auth 候选现在走 auth mirror 统一删除，避免只删一个 runtime 后又被其他 runtime 或 canonical 副本恢复。

### English
- `/auth` now marks candidates that have been proven unusable and could not be recovered through local/cross-node sync as “needs login repair”, shows a `?` action, and excludes them from auto-rotation, proactive refresh, and the enabled filter.
- Tapping `?` opens a repair menu: Login repair runs device-code login for that candidate and clears the repair state on success; Delete removes the candidate from canonical storage and all local bot runtimes while clearing quota cache.
- Auth candidate deletion now flows through the auth mirror so deleting a candidate from one runtime is not undone by another runtime or canonical copy.

## 0.5.14 - 2026-06-08

### 中文
- Linux `foxclaw start` / `foxclaw restart` / `install-systemd` 现在如果检测到自己正运行在 `foxclaw.service` cgroup 内，会通过一次性的 `systemd-run --user` helper 在服务外执行重启，避免命令执行者被自己重启时杀掉导致半截输出或不确定状态。
- 继续保留 systemd 作为稳定守护层：主 service 仍由 `Restart=always`、`KillMode=control-group` 和 user linger 保活；重启编排则交给短生命周期 helper，避免再引入一个更脆弱的常驻 Node 守护进程。

### English
- On Linux, `foxclaw start`, `foxclaw restart`, and `install-systemd` now detect when they are running inside the `foxclaw.service` cgroup and delegate the actual restart to a one-shot `systemd-run --user` helper outside that cgroup, avoiding half-written output or uncertain state when the caller would otherwise kill itself.
- systemd remains the stable supervisor with `Restart=always`, `KillMode=control-group`, and user linger; restart orchestration moves to a short-lived helper instead of adding another long-running Node watchdog.

## 0.5.13 - 2026-06-08

### 中文
- `auth.json_team_<localpart>` 候选现在会校验文件内 ChatGPT email localpart 是否匹配候选名；不匹配时 `/auth` 标为无效，避免继续显示另一位 seat 的额度。
- 本机 auth mirror 不再传播 team 候选名与文件身份不一致的 auth，并会在启动 reconcile 时用仍然匹配候选名的 runtime 副本修复错误副本。
- `/auth refresh all` 和当前候选额度刷新会跳过身份与 `team_` 候选名不匹配的文件，避免脏额度快照再次写入。

### English
- `auth.json_team_<localpart>` candidates now verify that the ChatGPT email local part inside the auth file matches the candidate name; mismatches are marked invalid in `/auth` instead of displaying another seat's quota.
- The local auth mirror no longer propagates team candidates whose filename identity and auth payload disagree, and startup reconciliation can repair bad copies from a runtime copy that still matches the candidate name.
- `/auth refresh all` and current-candidate quota refresh now skip files whose identity does not match the `team_` candidate name, preventing dirty quota snapshots from being recorded again.

## 0.5.12 - 2026-06-08

### 中文
- `/auth` 额度快照现在按 ChatGPT 额度身份合并，优先区分 `chatgpt_user_id`，其次区分 email，避免同一个 Team account 下不同 seat 显示成同一份额度。
- 本机 auth mirror、跨节点 auth sync 和 `/auth refresh all` 会拒绝可识别为不同 ChatGPT 用户/邮箱的同名候选互相覆盖，即使它们共享同一个 account id。
- 额度快照数据库新增 `quota_identity_id` 并自动兼容旧数据；文档同步说明 account id 与额度身份的区别。

### English
- `/auth` quota snapshots now merge by ChatGPT quota identity, preferring `chatgpt_user_id` and then email, so different seats under the same Team account do not display as one shared quota.
- Same-node auth mirroring, cross-node auth sync, and `/auth refresh all` now refuse to overwrite same-name candidates when they are identifiable as different ChatGPT users/emails, even if they share the same account id.
- Added a `quota_identity_id` quota-snapshot migration with backward compatibility for old data, and updated docs to distinguish account id from quota identity.

## 0.5.11 - 2026-06-08

### 中文
- `/auth` 面板的 `Bot runtime` 现在显示 Telegram bot id，例如 `@WuguiAI2_Bot (bot8949529424)`，便于和 `~/.foxclaw/codex/telegram/<botid>/home` 对应。
- `/auth` 面板新增“安全同步”按钮，并支持 `/auth sync safe`，可在全局空闲时安全打平本机多 bot auth，并把已校验的候选推送到跨节点 peer。
- 本机 auth mirror 新增全量安全同步路径：只传播通过既有在线校验的刷新候选，同时补齐 canonical 中已知、同账号且更新的 runtime 副本。

### English
- The `/auth` panel now shows the Telegram bot id in `Bot runtime`, for example `@WuguiAI2_Bot (bot8949529424)`, making it easy to match the runtime with `~/.foxclaw/codex/telegram/<botid>/home`.
- Added a Safe sync button to the `/auth` panel, plus `/auth sync safe`, to flatten same-node multi-bot auth while globally idle and push validated candidates to cross-node peers.
- Added a full safe-sync path for the local auth mirror: it only propagates candidates that pass the existing online validation and fills runtime copies from newer same-account canonical candidates.

## 0.5.10 - 2026-06-08

### 中文
- Telegram 输入队列改为 SQLite 持久化 FIFO，FoxClaw 重启后不再丢失排队中的 Codex 请求，并在 `/status` 中显示排队数量。
- Telegram 图片和文件会先进入附件暂存区，支持媒体组归并、下一条文字自动带附件发给 Codex，以及“分析 / 清空”按钮操作。
- 引导式 Plan 会话现在会持久化并在重启后恢复，减少长任务或确认流程被服务重启打断的风险。
- `/update` 完成回报会从已安装包的 `CHANGELOG.md` 读取当前版本更新内容，让 Telegram 里直接看到这次升级改了什么。

### English
- Replaced the in-memory Telegram prompt queue with a persisted SQLite FIFO so queued Codex requests survive FoxClaw restarts, and `/status` now reports queued turn count.
- Telegram photos and files are staged before dispatch, with media-group merging, next-message attachment consumption, and Analyze/Clear buttons.
- Guided Plan sessions are persisted and restored after restart, reducing interruption risk for long-running or confirmation-based flows.
- `/update` completion reports now read the installed package `CHANGELOG.md` entry for the target version so Telegram shows what changed in the upgrade.

## 0.5.9 - 2026-06-07

### 中文
- Linux 用户级 systemd 安装现在会在 `foxclaw start` / `restart` / `install-systemd` 时自动尝试启用 systemd user linger，避免用户退出 SSH 或桌面会话后 FoxClaw 停止接收 Telegram 消息。
- `foxclaw doctor` 新增 linger 状态检查；如果自动启用失败，会提示使用 `sudo loginctl enable-linger <user>` 手动修复。
- 中文/英文安装指南和故障排查文档更新为默认自动处理 linger，失败时再手动介入。

### English
- Linux user-systemd installation now tries to enable systemd user linger during `foxclaw start`, `restart`, and `install-systemd`, preventing FoxClaw from stopping after SSH or desktop logout.
- `foxclaw doctor` now checks linger state and tells users to run `sudo loginctl enable-linger <user>` if automatic setup fails.
- Updated the Chinese and English install and troubleshooting docs to describe automatic linger setup with manual recovery only when needed.

## 0.5.8 - 2026-06-05

### 中文
- 为跨节点 auth 同步新增持久化事件环，记录 push、pull、lease、test 和远端导入的发送、接收、超时、跳过、导入、失败等阶段。
- `/auth sync status` 现在展示 peer 最近活跃时间和最近事件，让“peer 在线但某次请求超时”“候选失败但同步系统正常”更容易判断。
- 新增 `/auth sync events [过滤]` 和 `/auth sync trace <requestId>`，可按候选名、peer、事件类型或请求 ID 查看 bot_to_bot 通讯流水。
- 事件记录包含 requestId、peer、candidateName 和阶段详情，同时保留既有加密协议兼容性。

### English
- Added a persisted event ring for cross-node auth sync, recording send, receive, timeout, skip, import, and failure stages for push, pull, lease, test, and remote-import flows.
- `/auth sync status` now includes peer recent activity and recent events, making it easier to distinguish "peer reachable but this request timed out" from candidate-specific failures.
- Added `/auth sync events [filter]` and `/auth sync trace <requestId>` to inspect bot-to-bot traffic by candidate name, peer, event kind, or request ID.
- Event records include requestId, peer, candidateName, and stage details while keeping the existing encrypted protocol backward-compatible.

## 0.5.7 - 2026-06-05

### 中文
- 修复普通 `/login_device` 和 `/auth` 面板设备登录完成后只更新本机当前 auth、没有主动同步到同节点 bot home 和跨节点 peer 的问题。
- 设备登录成功后，FoxClaw 现在会解析当前 auth 候选并调用既有 `authCandidateUpdated` 路径，和 `/auth add <name>`、auth 切换、reload、主动刷新保持一致。

### English
- Fixed normal `/login_device` and `/auth` panel device-login completions updating only the local current auth without actively syncing to same-node bot homes or cross-node peers.
- After a successful device login, FoxClaw now resolves the current auth candidate and calls the existing `authCandidateUpdated` path, matching `/auth add <name>`, auth switching, reload, and proactive refresh behavior.

## 0.5.6 - 2026-06-04

### 中文
- 新增后台主动 auth 刷新：已启用的 ChatGPT 候选 `last_refresh` 超过 9 天时，FoxClaw 每小时检查并在全局空闲后只刷新这批候选。
- 主动刷新会先申请跨节点刷新锁；没有启用跨节点同步时使用同进程本地锁，避免同节点多个 bot 并发轮换 refresh token。
- 跨节点刷新锁持有窗口延长到 10 分钟，刷新中会让 auth sync 处于非空闲状态，重复申请会被拒绝；完成后会私聊报告刷新、跳过和失败数量。
- 中文/英文用户手册和跨节点同步文档补充 9 天主动刷新策略，明确 `/auth refresh all confirm` 仍是人工维护命令。

### English
- Added background proactive auth refresh: every hour FoxClaw checks enabled ChatGPT candidates whose `last_refresh` is older than 9 days and refreshes only that due batch after the node is globally idle.
- Proactive refresh first requests the cross-node refresh lease; when cross-node sync is disabled, an in-process local lease prevents same-node bot runtimes from rotating refresh tokens concurrently.
- Extended the cross-node refresh lease window to 10 minutes, marks auth sync non-idle while a lease is active, rejects duplicate lease requests, and reports refreshed/skipped/failed counts in private chat.
- Updated the Chinese and English user manuals plus cross-node sync docs with the 9-day proactive policy, while keeping `/auth refresh all confirm` as a manual maintenance command.

## 0.5.5 - 2026-06-04

### 中文
- 在 `/login_device`、`/auth add <name>` 和 `/auth` 面板设备登录返回内容中加入 ChatGPT 设备代码授权前置条件：在 ChatGPT 左下角用户名菜单进入“设置 > 安全”，启用“为 Codex 启用设备代码授权”。
- README、安装指南、用户手册和故障排查补充同一指引，并强调 workspace 账号可能需要管理员允许设备码登录，以及设备代码不要分享给他人或粘贴到不可信页面。

### English
- Added a device-code authorization prerequisite to `/login_device`, `/auth add <name>`, and the `/auth` panel Login response: in ChatGPT, open the lower-left username menu, then Settings > Security, and enable device code authorization for Codex.
- Added the same guidance to the README, install guide, user manual, and troubleshooting docs, including workspace-admin requirements and the warning not to share device codes or paste them into untrusted pages.

## 0.5.4 - 2026-06-04

### 中文
- 修复 `/update` 遗留 `self-update.json` pending 后永久显示“升级已经在进行中”的问题：pending 超过 15 分钟会自动转为失败状态，Telegram 会回报失败，下一次 `/update` 可以重新发起。
- 这个补丁专门兜底 0.5.2 在 `KillMode=control-group` 下被杀掉的旧 updater，以及任何未来被外部中断、没有写完成状态的升级进程。

### English
- Fixed `/update` getting permanently stuck on "update already running" after a leftover `self-update.json` pending state: pending updates now expire as failed after 15 minutes, Telegram reports the failure, and the next `/update` can start again.
- This specifically recovers from the 0.5.2 updater killed by `KillMode=control-group`, and from any future updater interruption that fails to write a terminal status.

## 0.5.3 - 2026-06-04

### 中文
- 修复 0.5.2 中 `/update` 完成回报丢失的问题：Linux 自升级子进程现在通过独立的 user systemd transient service 运行，不再留在 `foxclaw.service` control group 里，因此 `KillMode=control-group` 重启服务时不会提前杀掉 updater。
- 保留 `KillMode=control-group` 的 app-server 清理能力，同时让升级进程能在服务重启后继续写入完成状态，由新服务启动后的轮询发送 Telegram 成功/失败回报。

### English
- Fixed missing `/update` completion reports in 0.5.2: on Linux the self-update worker now runs in a separate user systemd transient service instead of the `foxclaw.service` control group, so `KillMode=control-group` no longer kills the updater during service restart.
- Kept `KillMode=control-group` app-server cleanup while allowing the updater to write its final status after restart; the newly started service polls that status and sends the Telegram success/failure report.

## 0.5.2 - 2026-06-04

### 中文
- Linux systemd unit 改为停止整个 control group，避免升级或重启 FoxClaw 后旧的 `codex app-server --listen` 子进程残留。
- 启动时自动修复 `auth.json -> .auth-sync-validate-*` 临时验证 symlink 残留，恢复到 mirror 状态候选或同目录最近修改且可解析的真实 `auth.json_*` 候选，并清理临时文件。
- 跨节点 auth 同步把单候选验证/导入失败记录为“候选失败”，不再污染全局 `lastError`；`/status` 和 `/auth sync status` 会分开展示同步系统错误与候选失败。
- 手动 `/auth` 切换和 `/auth reload` 只做同节点本地镜像恢复，不再主动向跨节点 peer 查询；只有自动 auth 故障恢复才会跨节点 pull。
- auth 恢复超时通知补充 request id、候选名、peer、等待时长，并标明等待期间可达但本请求超时的 peer。

### English
- Changed the Linux systemd unit to stop the whole service control group so FoxClaw upgrades or restarts no longer leave old `codex app-server --listen` children behind.
- Added startup recovery for `auth.json -> .auth-sync-validate-*` validation symlink leftovers, restoring to the mirror-status candidate or the newest parseable real `auth.json_*` candidate in the same directory and removing stale temp files.
- Cross-node auth sync now records per-candidate validation/import failures as candidate failures instead of global `lastError`; `/status` and `/auth sync status` show sync-system errors separately from candidate failures.
- Manual `/auth` switching and `/auth reload` now recover from same-node local mirrors only and no longer query cross-node peers; cross-node pull is reserved for automatic auth-failure recovery.
- Auth recovery timeout notifications now include request id, candidate name, peers, wait duration, and whether a peer was reachable during the timed-out request.

## 0.5.1 - 2026-06-04

### 中文
- 串行化跨节点 auth 远端导入验证，避免多个同步包同时触发 usage 验证并反复重启同一个 Codex app-server，导致误报 `Codex app bridge stopped` 或 `SIGTERM`。

### English
- Serialized cross-node auth remote import validation so multiple incoming bundles no longer validate in parallel and repeatedly restart the same Codex app-server, avoiding false `Codex app bridge stopped` or `SIGTERM` failures.

## 0.5.0 - 2026-06-04

### 中文
- 明确跨节点 auth 同步推荐架构：每节点一个联系人 bot；多 bot 模式默认使用 `TG_BOT_TOKENS` 的第一个 token 作为联系人，同节点其他 bot 继续走本机 auth 镜像。
- `/auth sync status` 和 `/status` 现在显示联系人 bot，避免在非联系人 bot 上执行命令时误判实际发包身份。
- `/auth sync test` 升级为等待 peer 加密 pong 的真实握手，并显示未回应 peer；同时文档补充 BotFather MiniApp 入口、不要误进 Configure Mini App，以及 `push all` 只代表发送成功、不代表对端已导入。
- 跨节点 auth 同步现在会通过联系人 bot 私聊通知发送、接收、排队、导入、跳过、失败和恢复查询进度；所有 peer 都无法提供可用副本时会明确提示人工介入。

### English
- Clarified the recommended cross-node auth sync topology: one contact bot per node. In multi-bot mode, the first `TG_BOT_TOKENS` entry is the default contact while other same-node bots keep using local auth mirroring.
- `/auth sync status` and `/status` now show the contact bot so commands run from a non-contact bot no longer obscure the actual sender identity.
- `/auth sync test` now waits for encrypted peer pong replies and reports missing peers. Documentation now covers the BotFather MiniApp entry point, avoids the Configure Mini App confusion, and explains that `push all` only proves send success, not peer import.
- Cross-node auth sync now sends contact-bot private notifications for send, receive, queue, import, skip, failure, and recovery query progress; it explicitly asks for manual intervention when every peer lacks an importable copy.

## 0.4.16 - 2026-06-04

### 中文
- 新增独立的跨节点 auth 同步中文/英文配置指南，覆盖设计模型、`.env` 配置、`@BotFather` Bot-to-Bot Communication Mode 操作、验证步骤和故障排查。
- 在 README、README_EN 和用户手册中加入可发现入口，让新用户能从 GitHub/npm 首页一路点到多节点 auth 同步配置说明。

### English
- Added standalone Chinese and English cross-node auth sync setup guides covering the design model, `.env` config, `@BotFather` Bot-to-Bot Communication Mode steps, verification, and troubleshooting.
- Linked the guides from README, README_EN, and the user manuals so new users can find multi-node auth sync setup from the GitHub/npm landing page.

## 0.4.15 - 2026-06-04

### 中文
- 更新 FoxClaw 收尾 skill：发布前固定检查设计文档、中文/英文使用手册和对外公开文档。
- 涉及 Telegram 设置的变更，使用手册必须写清 `@BotFather` 操作步骤；npm 发布 skill 也会遵守该项目文档门槛。

### English
- Updated the FoxClaw wrap-up skill to require design docs, Chinese/English user manuals, and public-facing docs before release.
- Telegram setup changes must document the exact `@BotFather` steps in the manuals; the npm publish skill now honors this project documentation gate too.

## 0.4.14 - 2026-06-04

### 中文
- 新增可选跨节点 auth 同步：通过 Telegram Bot-to-Bot 私聊传输 AES-GCM 加密 auth 包，无需公网 IP 或 FRP。
- 跨节点同步支持双主动：本机验证刷新后主动 push，切换/重载前本机恢复失败时主动 pull peer 已持有的有效副本。
- `/auth sync status|test|push all` 可查看状态、测试 peer/密钥、手动推送全部已验证候选；远端导入必须等全局空闲并通过 usage 验证后才写盘。
- `/auth refresh all confirm` 在启用跨节点同步时会先申请跨节点刷新锁；任一 peer 忙碌、拒绝或无响应都会阻止 refresh token 轮换。

### English
- Added optional cross-node auth sync using AES-GCM encrypted auth bundles over Telegram Bot-to-Bot private messages, with no public IP or FRP required.
- Added dual-active sync behavior: locally validated refreshes are pushed, and auth switch/reload recovery can pull an already-held valid peer copy when local recovery fails.
- Added `/auth sync status|test|push all` for status, peer/key testing, and manual broadcast of verified candidates. Remote imports wait for global idleness and usage validation before writing files.
- When cross-node sync is enabled, `/auth refresh all confirm` requests a cross-node refresh lease first; any busy, denying, or non-responsive peer blocks refresh-token rotation.

## 0.4.13 - 2026-06-03

### 中文
- `/update` 完成回报新增 Codex CLI 版本变化，和 FoxClaw 版本变化并排行展示。
- `/auth` 文本列表继续保留额度窗口详情，候选按钮改为只显示两个剩余百分比数字，未知值用 `—`，减少窄屏按钮截断。

### English
- Added Codex CLI from/to version reporting to completed `/update` messages alongside the FoxClaw version change.
- Kept quota-window detail in `/auth` text rows, while compacting candidate buttons to two remaining-percent numbers with `—` for unknown values.

## 0.4.12 - 2026-06-02

### 中文
- `/auth` 面板顶部、候选列表和切换按钮省略标准候选名中重复的 `auth.json_` 前缀，让额度与账号标识在窄屏 Telegram 客户端中更容易完整显示。
- 磁盘文件名、文件名搜索、候选编号、切换和镜像同步行为保持不变；非标准候选名仍原样展示。

### English
- Omitted the repeated `auth.json_` prefix from the `/auth` panel header, candidate rows, and switch buttons so quota and account labels fit better in narrow Telegram clients.
- Kept filenames on disk, filename search, candidate numbering, switching, and mirroring unchanged. Non-standard candidate names still render verbatim.

## 0.4.11 - 2026-06-02

### 中文
- `/auth` 面板改为每页 8 个候选，新增翻页、`全部 / 已启用 / 需关注` 筛选、文件名搜索和直接跳页命令，支持管理较大的本地候选清单。
- 额度快照保存真实窗口时长与套餐类型，面板不再假定所有账号都有 5 小时和 7 天窗口；单一月额度账号可显示为 `30d:97`。
- 候选摘要新增正常、额度偏低、额度耗尽、额度未知、长期未刷新、API key 和无效 auth 文件状态；超过约 8 天未刷新只作为维护提醒，不会触发批量保活刷新。

### English
- Paginated `/auth` at 8 candidates per page and added paging, `All / Enabled / Attention` filters, filename search, and direct page commands for larger local inventories.
- Persisted observed quota-window lengths and plan types so the panel no longer assumes every account has 5-hour and 7-day windows; a single monthly allowance can render as `30d:97`.
- Added ready, low-quota, exhausted, unknown, not-recently-refreshed, API-key, and invalid-auth-file summaries. The roughly 8-day stale hint remains informational and never triggers bulk keepalive refreshes.

## 0.4.10 - 2026-06-02

### 中文
- 从 `/auth` 面板移除“刷新全部”按钮，避免高风险 refresh token 轮换操作被日常面板误触。
- 保留 `/auth refresh all` 和 `/auth refresh all confirm` 命令入口，继续要求显式风险确认后才会执行刷新全部。

### English
- Removed the Refresh all button from the `/auth` panel to avoid accidental use of the high-risk refresh-token rotation maintenance action.
- Kept `/auth refresh all` and `/auth refresh all confirm` as command entry points, still requiring explicit risk confirmation before refresh all runs.

## 0.4.9 - 2026-06-02

### 中文
- 修复 ChatGPT auth 到期自动刷新后，主动同步和后台镜像扫描竞态导致同一候选重复发送镜像广播的问题。

### English
- Fixed duplicate auth mirror broadcasts when an automatic ChatGPT auth refresh was observed by both the direct sync path and the background mirror scan.

## 0.4.8 - 2026-06-02

### 中文
- `/auth` 面板的“刷新全部”改为两段式确认：首次点击只显示 refresh token 轮换风险，只有点击“接受风险并刷新”才会真正执行。
- `/auth refresh all` 同样只显示风险确认；需要 `/auth refresh all confirm` 或确认按钮才会开始刷新。
- 本地 CLI 测试会过滤 proxychains 初始化噪音，避免发布前校验被环境 stdout 污染误伤。

### English
- Changed the `/auth` panel's Refresh all action to a two-step confirmation: the first tap only shows refresh-token rotation risk, and the refresh starts only after accepting the risk.
- `/auth refresh all` now shows the same risk confirmation; `/auth refresh all confirm` or the confirmation button is required to run it.
- Local CLI tests now filter proxychains initialization noise so release checks are not tripped by environment stdout injection.

## 0.4.7 - 2026-06-02

### 中文
- `/auth` 面板新增“刷新全部”按钮，并支持 `/auth refresh all`。
- 刷新全部仅在所有 Telegram runtime、微信 runtime、审批、待输入、登录流程和 auth 镜像写入都空闲时执行。
- 执行时逐个切换 ChatGPT 候选，调用 Codex `account/read refreshToken=true` 主动刷新，使用 usage 接口验证后再镜像同步，并在结束后恢复原当前 auth、刷新面板摘要。
- 更新 FoxClaw/npm 发布 skill：用户要求收尾或发布时，校验通过后自动 commit、push、publish，只在真实外部阻塞时再等待用户。

### English
- Added a Refresh all button to the `/auth` panel and the `/auth refresh all` command.
- Refresh all runs only when every Telegram runtime, the Weixin runtime, approvals, inputs, login flows, and auth mirror writes are idle.
- It visits each ChatGPT candidate, calls Codex `account/read refreshToken=true`, validates through the usage endpoint before mirroring, restores the original current auth, and refreshes the panel summary.
- Updated the FoxClaw/npm publish skills so release wrap-up proceeds through commit, push, and publish after validation, pausing only for real external blockers.

## 0.4.6 - 2026-06-01

### 中文
- 新增公开 `CHANGELOG.md`，让 GitHub 项目首页和 npm 包都能直接看到版本更新记录。
- README 增加更新日志入口，并将 `CHANGELOG.md` 纳入 npm 发布包。
- 发布 workflow 增加 GitHub Release 创建/更新步骤，后续 tag 发布会自动带上对应版本说明。

### English
- Added a public `CHANGELOG.md` so release notes are visible from GitHub and the npm package.
- Linked the changelog from the README and included it in the npm package contents.
- Added GitHub Release creation/update to the publish workflow so future version tags carry release notes automatically.

## 0.4.5 - 2026-06-01

### 中文
- `/auth` 面板点击切换账号后会刷新原消息并保留按钮，方便连续切换多个候选账号。
- 回归测试覆盖同一个面板上连续切换的行为。

### English
- The `/auth` panel now refreshes the original message and keeps its buttons after switching accounts, making consecutive switches practical.
- Added regression coverage for repeated switches from the same panel.

## 0.4.4 - 2026-06-01

### 中文
- 多 bot 模式下，切换或重载认证前会从其他 bot home 和规范凭据目录恢复同账号的较新可用候选。
- 认证同步前增加在线 usage 验证，避免只看 `last_refresh` 时传播已经失效的凭据。
- 登录/刷新成功后继续将同账号新凭据镜像到其他 runtime，解决某个 bot 仍拿到旧 401 凭据的问题。

### English
- In multi-bot mode, auth switch/reload now recovers a newer same-account candidate from other bot homes or the canonical auth directory before restart.
- Added online usage validation before syncing refreshed credentials, avoiding propagation based only on `last_refresh`.
- Successful login/refresh still mirrors the validated same-account credential to other runtimes, fixing stale 401 credentials in sibling bots.

## 0.4.3 - 2026-05-29

### 中文
- `/auth` 在多 bot 模式下会按 ChatGPT account id 汇总各 runtime 最近掌握的额度快照。
- 不同 bot 使用不同 auth 时，面板可以互补展示更完整的 5 小时/7 天额度信息。

### English
- `/auth` now merges recent quota snapshots by ChatGPT account id across runtimes in multi-bot mode.
- When different bots use different auth candidates, the panel can present a more complete 5-hour/7-day quota view.

## 0.4.2 - 2026-05-28

### 中文
- 支持把 `TG_BOT_TOKENS` 中的一个 bot 标记为默认/终端共享 runtime。
- 当 `TG_BOT_TOKEN` 精确匹配复数 token 中的一个值时，该 bot 使用终端默认 `CODEX_HOME` 和默认 auth，其他 bot 继续隔离。
- 文档补充共享 runtime 的配置方式和注意事项。

### English
- Added support for marking one `TG_BOT_TOKENS` bot as the default/shared-terminal runtime.
- When `TG_BOT_TOKEN` exactly matches one token in the multi-token list, that bot uses the terminal/default `CODEX_HOME` and auth while the others stay isolated.
- Updated docs with shared-runtime setup guidance.

## 0.4.1 - 2026-05-28

### 中文
- 认证候选刷新后，镜像同步前会校验同账号和可用性，降低错误凭据扩散风险。
- 增加认证刷新验证相关测试。

### English
- Refreshed auth candidates are validated for same-account usability before mirroring, reducing the risk of spreading bad credentials.
- Added tests for refreshed auth validation.

## 0.4.0 - 2026-05-27

### 中文
- 完善多 Telegram bot 隔离 runtime 的状态展示、验收路径和文档。
- 补充多 bot auth 镜像、独立 `CODEX_HOME`、群聊点名规则和全局 `/update` 空闲检查说明。

### English
- Completed status reporting, validation paths, and docs for isolated multi-Telegram-bot runtimes.
- Documented multi-bot auth mirroring, independent `CODEX_HOME`, group addressing rules, and global `/update` idle checks.

## 0.3.19 - 2026-05-27

### 中文
- 支持一个 FoxClaw 服务同时运行多个 Telegram bot，每个 bot 拥有独立 Codex app-server、独立 `CODEX_HOME`、独立会话和独立当前 auth。
- Telegram scope 加入 bot namespace，避免私聊、群聊、按钮回调和附件处理串线。
- 新增认证候选镜像协调器，仅同步经过校验的同账号候选文件，不共享 Codex sessions。
- `/update` 改为全服务空闲检查，并会尝试同步升级 npm/pnpm 管理的 Codex CLI。

### English
- Added support for running multiple Telegram bots in one FoxClaw service, with independent Codex app-servers, `CODEX_HOME` directories, sessions, and active auth selections.
- Added bot namespaces to Telegram scopes so private chats, groups, callbacks, and media handling do not cross runtimes.
- Added an auth candidate mirror coordinator that syncs validated same-account candidates without sharing Codex sessions.
- Made `/update` a global idle-checked operation and added npm/pnpm-managed Codex CLI update attempts.

## 0.3.18 - 2026-05-27

### 中文
- 修正 Codex 本地答复吞吐统计口径。

### English
- Corrected local Codex response throughput metrics.

## 0.3.17 - 2026-05-26

### 中文
- 修复 GitHub 发布流程的 checkout 鉴权失败。

### English
- Fixed checkout authentication failure in the GitHub release workflow.

## 0.3.16 - 2026-05-26

### 中文
- 缓存 `/status` 本地用量统计快照，减少状态页等待时间并优化响应。

### English
- Cached local usage statistics for `/status`, reducing wait time and improving responsiveness.

## 0.3.15 - 2026-05-26

### 中文
- 修复 pnpm 全局安装下 `/update` 对 Codex CLI 真实安装路径的识别。

### English
- Fixed `/update` detection of the real Codex CLI install path under pnpm global installs.

## 0.3.14 - 2026-05-26

### 中文
- 新增 FoxClaw 一键自升级和聊天内 `/update` 命令。

### English
- Added one-command FoxClaw self-update and the chat `/update` command.

## 0.3.13 - 2026-05-26

### 中文
- 新增 Codex 输出速度展示和线程上下文回显。

### English
- Added Codex output throughput display and thread context echoes.

## 0.3.12 - 2026-05-26

### 中文
- 简化 FoxClaw 代理服务配置。

### English
- Simplified FoxClaw proxy service configuration.

## 0.3.11 - 2026-05-26

### 中文
- 修复 systemd 安装时覆盖旧版本路径的问题。

### English
- Fixed systemd install behavior that could overwrite an older version path incorrectly.

## 0.3.10 - 2026-05-26

### 中文
- 支持 npm 发布令牌回退，用于 trusted publishing 不可用时的补发路径。

### English
- Added npm token fallback support for manual recovery when trusted publishing is unavailable.

## 0.1.1 - 2026-03-06

### 中文
- 显式解析 Codex 二进制路径，提升运行时定位可靠性。

### English
- Resolved the Codex binary path explicitly for more reliable runtime startup.

## 0.1.0 - 2026-03-06

### 中文
- 初始化 Telegram Codex app bridge。

### English
- Bootstrapped the Telegram Codex app bridge.
