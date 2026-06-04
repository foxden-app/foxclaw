# Changelog

All notable FoxClaw changes are listed here. Each release note is bilingual so GitHub Releases and the npm package are useful to both Chinese and English readers.

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
