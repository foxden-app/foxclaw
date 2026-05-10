# Telegram x Codex Interaction Redesign TODO

## Goal

Make the Telegram bridge feel as close to Codex App as possible while supporting both `private chat` and `topic` usage.

## Phase 0: Baseline Confirmation

- [x] Confirm the current bridge routing for `private chat`, `private topic`, and `group topic`
- [x] Confirm Telegram API capability boundaries: where `sendMessageDraft` is available and where fallback rendering is required
- [x] Confirm current upstream event sources: `item/*`, raw events, `exec_command_begin/end`, interrupt, and approval

Acceptance criteria:

- [x] A clear `chat type -> renderer` routing table exists
- [x] Event ingestion and UI rendering are no longer coupled conceptually

## Phase 1: Unified Event Model

- [x] Normalize Codex-side events into one internal activity stream
- [x] Define internal activity states: `thinking`, `reading`, `searching`, `editing`, `running_command`, `approval_waiting`, `completed`
- [x] Define output buckets: `commentary`, `final_answer`, `tool_summary`, `error`

Acceptance criteria:

- [x] The same event stream can drive both the `private renderer` and the `topic renderer`
- [x] Renderer changes no longer require touching core event parsing

## Phase 2: Private Renderer

- [x] In `private chat` and `private topic`, choose the renderer that preserves visible stream continuity first
- [x] Keep `sendMessageDraft` as a capability boundary check, but default the private path to stable segmented live messages until draft UX is proven reliable
- [x] Ensure status text never overwrites visible body output
- [x] Keep the current status and interrupt affordance coherent once body output begins

Acceptance criteria:

- [x] No stale top status bar remains in private mode
- [x] Live body output is not replaced by generic `正在回复...` text
- [x] Interrupt controls do not require destroying visible output to stay available

## Phase 3: Topic Renderer

- [x] Keep `group topic` on normal-message rendering
- [x] Use `bottom activity card + segmented body messages` to approximate Codex App behavior
- [x] Stop editing one giant body message forever
- [x] Separate tool-action summaries from body messages

Acceptance criteria:

- [x] Topic mode no longer leaves an old status message hanging at the top
- [x] Body output lands in readable stage-based chunks

## Phase 4: Activity Card Semantics

- [x] Support Codex-App-like states such as `正在思考`, `正在浏览 2 个文件, 1 个搜索`, `已浏览 ...`
- [x] Archive each finished activity summary before moving to the next stage
- [x] Keep status cards focused on current activity, not long-form body content

Acceptance criteria:

- [x] Users can always tell what the bot is doing right now
- [x] Status transitions are continuous and understandable

## Phase 5: Tool Details And Folding

- [x] Group `Read ...`, `Searched for ...`, `Ran ...`, and `Edited ...` into tool-detail summaries
- [x] Use foldable rendering when Telegram allows it; otherwise keep summaries short and details clear
- [x] Improve edit summaries so they are closer to Codex App output

Acceptance criteria:

- [x] Users can understand what operations were performed
- [x] Tool details do not drown out the assistant body text

## Phase 6: Interrupt And Approval Semantics

- [x] Show `已请求中断` immediately after an interrupt is requested
- [x] Mark any post-interrupt residual output as partial output
- [x] Represent approval waiting separately from thinking/output states
- [x] Clean up stale buttons, stale status cards, and invalid controls

Acceptance criteria:

- [x] Users can distinguish thinking, waiting for approval, winding down, and interrupted states
- [x] The UI no longer feels frozen or semantically misleading after an interrupt

## Phase 7: Recovery And Stability

- [x] Recover activity-card and body state after transient Telegram/network failures
- [x] Restore visible active-turn state as well as possible after a bridge restart
- [x] Prevent duplicate polling, duplicate sends, and duplicate archived summaries

Acceptance criteria:

- [x] Tested transient Telegram/network failures are retried instead of silently abandoning the live UI
- [x] Service restarts retire stale live state and avoid obviously broken status sequences in the next visible turn

## Phase 8: Config, Docs, And Tests

- [x] Document the intended behavior: private chat preferred, topic fallback, capability matrix
- [x] Add regression coverage for renderer routing, activity normalization, status selection, and lock/recovery primitives
- [x] Document which effects are only achievable in private chat and which are approximations in topic mode

Acceptance criteria:

- [x] The behavior boundaries are documented
- [x] The documented guarantees match the current implementation and test scope

## Phase 9: Unified Preference Panel

- [x] Add `/setup` as the single Telegram preference panel for model, effort, Fast, access, Agent/Plan mode, and active-turn message behavior
- [x] Keep legacy entrypoints (`/models`, `/permissions`, `/model`, `/effort`, `/access`, `/mode`, `/plan`, `/agent`) as focused panel aliases unless a direct value is provided
- [x] Add `/fast on|off|toggle` backed by Codex `serviceTier`, with model capability checks and automatic downgrade when the selected model does not support the stored tier
- [x] Persist `service_tier` per chat scope in SQLite without changing desktop Codex App preferences
- [x] Persist `active_turn_message_mode` per chat scope, defaulting to `steer` when unset
- [x] Route `settings:*` callbacks through the new `setup:*` path for temporary backwards compatibility
- [x] Keep implementation anchors in `src/controller/presentation.ts` (`formatSetupPanelMessage`, `buildSetupPanelKeyboard`) and `src/controller/service_tier.ts`

Acceptance criteria:

- [x] `/setup` shows one summary line and one keyboard covering all preference groups
- [x] Active turns block model, effort, Fast, and mode buttons while allowing access changes
- [x] `/active steer|queue` controls whether plain messages during active turns steer immediately or queue the next turn
- [x] `/status`, `/where`, and Weixin copy-paste helpers surface Fast state
- [x] Regression tests cover service-tier resolution, storage migration, panel presentation, callbacks, command aliases, and turn/start propagation

## Phase 10: App-Server Priority Bridge

- [x] Add active-turn steering with `/steer <message>` backed by `turn/steer`
- [x] Add native account and quota controls: `/account`, `/quota`, `/quota_nudge`, `/login_device`, `/login_cancel`, `/auth add <name>`, and guarded `/logout confirm`
- [x] Add Skills management: `/skills`, `/skill <name>`, `/skill_enable <name>`, `/skill_disable <name>`, plus `skills/changed` notifications
- [x] Add MCP management: `/mcp`, `/mcp_reload`, `/mcp_login <server>`, `/mcp_resource <server> <uri>`, startup/OAuth notifications, and MCP elicitation replies
- [x] Add granular permission approvals for `item/permissions/requestApproval`
- [x] Add thread and review controls: `/fork`, `/undo`/`/rollback`, `/rename`, `/compact`, `/archive`, `/threads archived`, `/unarchive`, `/review`, and `/diff`
- [x] Keep implementation anchors in `src/codex_app/client.ts`, `src/controller/controller.ts`, `src/types.ts`, and `src/store/database.ts`

Acceptance criteria:

- [x] Telegram can trigger the priority app-server APIs without desktop Codex App interaction
- [x] Risky operations keep explicit commands or confirmation words (`/logout confirm`, `/quota_nudge ... confirm`)
- [x] Server requests that can block active turns (`permissions` and MCP elicitation) have Telegram-side response paths
- [x] Regression tests cover account/login, steering, permissions approval, MCP elicitation, Skills/MCP panels, and thread lifecycle commands

## Phase 11: Read-Only Diagnostics Bridge

- [x] Add `/loaded` for app-server loaded thread ids
- [x] Add `/hooks` for hook inventory and hook load warnings/errors
- [x] Add `/plugins`, `/plugin <name>`, and `/plugin_skill <marketplace> <plugin> <skill>` for plugin inventory and skill preview
- [x] Add `/apps [reload]` plus `app/list/updated` notifications
- [x] Add `/features`, `/config`, `/requirements`, and `/provider` for safe remote diagnosis of feature flags, effective config, managed requirements, and provider capabilities
- [x] Add lightweight notifications for `thread/status/changed`, high-water `thread/tokenUsage/updated`, `warning`, `guardianWarning`, `deprecationNotice`, and `configWarning`

Acceptance criteria:

- [x] New commands are read-only except explicit reload/refetch operations
- [x] Config output is summarized and avoids dumping full developer instructions or arbitrary config blobs into Telegram
- [x] Notification routing targets the bound thread scope when thread ids are available
- [x] Regression tests cover the new diagnostic commands and notification routing

## Phase 12: Experimental Thread Utilities

- [x] Add `/goal` for app-server thread goals: read, set, pause, resume, complete, budget update, and confirmed clear
- [x] Add `/history [limit]` backed by `thread/turns/list` for recent turn summaries without resuming another thread
- [x] Add `/files <query>` backed by `fuzzyFileSearch` for read-only path lookup in the bound cwd
- [x] Add `/remote` plus `remoteControl/status/changed` caching for remote-control diagnostics
- [x] Add lightweight notifications for `thread/goal/*`, `model/rerouted`, `model/verification`, and `item/mcpToolCall/progress`

Acceptance criteria:

- [x] New commands stay read-only or require explicit confirmation for destructive state (`/goal clear confirm`)
- [x] Commands operate on the current bound thread/cwd and fail clearly when no binding exists
- [x] Regression tests cover the new commands and notification routes
