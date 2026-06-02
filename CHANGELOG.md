# Changelog

All notable FoxClaw changes are listed here. Each release note is bilingual so GitHub Releases and the npm package are useful to both Chinese and English readers.

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
