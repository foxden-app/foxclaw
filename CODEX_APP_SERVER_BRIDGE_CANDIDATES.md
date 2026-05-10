# Codex App Server 可桥接功能候选清单

来源快照：

- 上游仓库：`../codex`
- 已检查的上游 HEAD：`ebe75bb683b3c237aad9f039ab17b187048aa499`
- 主要参考文件：`../codex/codex-rs/app-server/README.md`、`../codex/codex-rs/app-server-protocol/schema/json/ClientRequest.json`、`ServerRequest.json`、`ServerNotification.json`

这份文档用于挑选哪些 Codex App Server 能力值得桥接到 Telegram。里面同时包含高价值候选和低优先级协议面，方便你逐项勾选。

## 已经桥接或基本桥接

这些能力当前 bridge 已经有了。除非目标是补全体验或做细节优化，否则不用重新规划。

| 领域 | 上游 API | 当前 Telegram 入口 |
| --- | --- | --- |
| 线程基础 | `thread/start`、`thread/resume`、`thread/list`、`thread/read` | `/new`、`/threads`、`/open`、`/where`、自动线程绑定 |
| Turn 基础 | `turn/start`、`turn/interrupt` | 普通文本、附件、`/interrupt` |
| 模型 | `model/list` | `/models`、`/model`、`/effort` |
| 访问权限预设 | `thread/start` 和 `turn/start` 里的旧 approval/sandbox 字段 | `/permissions`、`/access` |
| Plan/Agent 模式 | `collaborationMode/list`、`turn/start.collaborationMode` | `/mode`、`/plan`、`/agent` |
| 账号状态 | `account/read`、`account/rateLimits/read` | `/status`，以及当前本地 `auth.json_*` 切换 `/auth` |
| 原生登录和额度 | `account/login/start`、`account/login/cancel`、`account/logout`、`account/sendAddCreditsNudgeEmail` 及账号通知 | `/account`、`/quota`、`/quota_nudge`、`/login_device`、`/login_cancel`、`/logout confirm` |
| Codex App 同步 | Codex deep link，不是 app-server RPC | `/reveal`、`/focus`、`/open` 后同步 |
| 审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` | Telegram 内联审批按钮 |
| 工具向用户提问 | `item/tool/requestUserInput` | Telegram 按钮和文本回复 |
| MCP 向用户提问 | `mcpServer/elicitation/request` | Telegram 问题卡片、按钮和 JSON 文本回复 |
| 观察外部 turn | `thread/read` 加 session log fallback | `/watch`、`/unwatch` |
| turn 控制辅助 | bridge 本地控制逻辑、`turn/steer` | `/takeover`、`/queue`、`/steer` |
| 线程生命周期 | `thread/fork`、`thread/rollback`、`thread/name/set`、`thread/compact/start`、`thread/archive`、`thread/unarchive` 及相关通知 | `/fork`、`/undo`、`/rename`、`/compact`、`/archive`、`/threads archived`、`/unarchive` |
| Review 和 diff | `review/start`、`turn/diff/updated` | `/review`、`/diff` |
| Skills | `skills/list`、`skills/config/write`、`skills/changed` | `/skills`、`/skill`、`/skill_enable`、`/skill_disable` |
| MCP 管理 | `mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServer/resource/read` 及相关通知 | `/mcp`、`/mcp_reload`、`/mcp_login`、`/mcp_resource` |
| 诊断面板 | `thread/loaded/list`、`hooks/list`、`plugin/list`、`plugin/read`、`plugin/skill/read`、`app/list`、`config/read`、`configRequirements/read`、`experimentalFeature/list`、`modelProvider/capabilities/read` | `/loaded`、`/hooks`、`/plugins`、`/plugin`、`/plugin_skill`、`/apps`、`/config`、`/requirements`、`/features`、`/provider` |

## 优先候选短名单

这些是最值得先考虑的 Telegram 候选：手机端有用、API 相对成熟、Telegram UI 也能承载。

| 勾选 | 候选功能 | 上游 API | 建议 Telegram 入口 | 价值 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 运行中补充指令 | `turn/steer` | `/steer <message>`，也可以考虑 active turn 期间普通消息自动 steer | 可以在 Codex 还在跑时追加约束或纠正，不用 interrupt 或 queue | 已实现显式 `/steer`；普通文本可用 `/active steer\|queue` 选择引导或排队 |
| [x] | 原生登录管理 | `account/login/start`、`account/login/cancel`、`account/logout`、`account/login/completed`、`account/updated` | `/login`、`/login_device`、`/auth add <name>`、`/logout`、`/account` | 用 app-server 官方登录流替代或补充当前 `auth.json_*` 文件切换 | 已实现 device-code 登录；新增账号可落到 switchable auth 候选；API key 登录仍不开放 |
| [x] | 账号额度操作 | `account/rateLimits/read`、`account/rateLimits/updated`、`account/sendAddCreditsNudgeEmail` | `/quota`、`/quota_nudge` | 不打开桌面也能看 quota 和触发额度提醒 | 发送邮件提醒要求 `confirm` |
| [x] | Skills 浏览器 | `skills/list`、`skills/changed`、`skills/config/write` | `/skills`、`/skill <name>`、`/skill_enable`、`/skill_disable` | 远程查看和管理 Codex skills | 已支持列表、详情、启用/禁用 |
| [x] | MCP 状态面板 | `mcpServerStatus/list`、`mcpServer/startupStatus/updated`、`config/mcpServer/reload` | `/mcp`、`/mcp_reload` | 远程排查工具不可用、MCP 启动失败、认证失败 | 已支持状态和 reload |
| [x] | MCP OAuth 登录 | `mcpServer/oauth/login`、`mcpServer/oauthLogin/completed` | `/mcp_login <server>` | 从 Telegram 修复 connector/MCP 认证 | 已支持授权 URL 和完成通知 |
| [x] | MCP 资源读取 | `mcpServer/resource/read` | `/mcp_resource <server> <uri>` | 直接读取 MCP server 提供的上下文资源 | 已支持文本/JSON 摘要，长内容裁剪 |
| [x] | MCP elicitation | `mcpServer/elicitation/request` | active turn 期间内联问题卡片/按钮 | 有些 MCP server 会中途向用户要结构化输入，不支持会卡住能力 | 已支持 accept/decline/cancel 和 JSON 文本回复 |
| [x] | 细粒度权限请求 | `item/permissions/requestApproval` | 内联权限审批卡片 | 新版 granular permissions 需要这个，否则部分流程会失败 | 已支持权限摘要和 approve/deny |
| [x] | 代码审查 | `review/start` | `/review`、`/review base <branch>`、`/review commit <sha>` | 手机端很适合触发 review，然后阅读 findings | 已复用 turn 渲染 |
| [x] | fork 线程 | `thread/fork` | `/fork [name]` | 在尝试高风险路径前复制一份对话分支 | 成功后 Telegram 绑定到新 fork |
| [x] | rollback 线程 | `thread/rollback` | `/undo [n]` 或 `/rollback [n]` | 从上下文中移除最近坏 turn | 已支持 active-turn guard |
| [x] | 重命名线程 | `thread/name/set`、`thread/name/updated` | `/rename <name>` | 让 `/threads` 更容易浏览 | 已支持命令和通知 |
| [x] | 手动压缩上下文 | `thread/compact/start` | `/compact` | 手机端继续长线程前主动压缩上下文 | 已作为普通 turn 注册渲染 |
| [x] | 归档/取消归档线程 | `thread/archive`、`thread/unarchive` 及通知 | `/archive`、`/unarchive <n>` | 远程整理线程列表 | 已支持 `/threads archived` |
| [x] | 完整 diff 展示 | `turn/diff/updated` | 实时或最终“变更”卡片 | 不只靠工具摘要，也能看到本轮实际改动 | 已支持 `/diff` 读取最近 diff，长内容裁剪 |

## 线程和 Turn 管理

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `turn/steer` | `/steer <message>` 或 active-turn 普通文本自动 steer | 高 | 已实现显式 `/steer` |
| [x] | `thread/fork` | `/fork [name]` | 高 | 已实现，并切换绑定到 fork 后线程 |
| [x] | `thread/rollback` | `/undo [n]`、`/rollback [n]` | 高 | 已实现 active-turn guard |
| [x] | `thread/name/set` | `/rename <name>` | 高 | 已实现，并监听 `thread/name/updated` |
| [x] | `thread/archive` | `/archive` | 中 | 已实现，归档当前线程后清理绑定 |
| [x] | `thread/unarchive` | `/threads archived`、`/unarchive <n>` | 中 | 已实现 archived 线程列表 |
| [x] | `thread/compact/start` | `/compact` | 中 | 已实现，作为 turn 渲染 |
| [x] | `thread/loaded/list` | `/loaded` 或合并进 `/status` | 低 | 已实现 `/loaded` |
| [ ] | `thread/unsubscribe` | watch/open 切换后的内部清理 | 低 | 如果以后改成原生订阅，可减少 app-server 订阅 |
| [ ] | `thread/metadata/update` | 暂不做直接用户命令 | 低 | 目前主要是 git metadata |
| [ ] | `thread/inject_items` | 高级导入/调试命令 | 低 | 容易误用，不像普通 Telegram 功能 |
| [ ] | `thread/shellCommand` | `/shell <cmd>` 或 `!cmd` | 低/高风险 | 上游说明它是 unsandboxed full access，默认不建议开 |
| [ ] | `thread/approveGuardianDeniedAction` | 内联“仍然执行”流程 | 低 | 需要仔细研究 guardian 语义 |

## Goal 和 Memory

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `thread/goal/set` | `/goal <objective>`、`/goal_pause`、`/goal_done` | 中 | 已实现 `/goal ...`、`/goal_pause`、`/goal_resume`、`/goal_done`、`/goal budget ...` |
| [x] | `thread/goal/get` | `/goal` | 中 | 已实现目标、状态、预算、用量展示 |
| [x] | `thread/goal/clear` | `/goal_clear` | 中 | 已实现 `/goal clear confirm` 和 `/goal_clear confirm` |
| [x] | `thread/goal/updated`、`thread/goal/cleared` | 被动状态更新 | 中 | 已实现轻量通知 |
| [ ] | `thread/memoryMode/set` | `/memory on`、`/memory off` | 低/中 | 实验能力；只有目标 Codex 开启 memories 时有价值 |
| [ ] | `memory/reset` | `/memory_reset` | 低/高风险 | 破坏性操作，必须强确认 |

## 登录、账号、额度

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `account/read` | `/account` | 高 | 已实现专门视图 |
| [x] | `account/login/start` with `chatgptDeviceCode` | `/login_device` | 高 | 已实现，显示设备登录 URL 和 code |
| [ ] | `account/login/start` with `chatgpt` | `/login_browser` | 中 | 对桌面宿主机有用，从手机触发价值稍低 |
| [ ] | `account/login/start` with `apiKey` | `/login_api_key` | 低/高风险 | 除非强需求，否则不建议；密钥会留在聊天记录 |
| [x] | `account/login/cancel` | `/login_cancel` | 中 | 已实现 |
| [x] | `account/logout` | `/logout` | 中 | 已实现 `/logout confirm` |
| [x] | `account/login/completed`、`account/updated` | 通知登录/登出结果 | 高 | 已实现 |
| [x] | `account/rateLimits/read`、`account/rateLimits/updated` | `/quota` | 高 | 已实现 |
| [x] | `account/sendAddCreditsNudgeEmail` | `/quota_nudge` | 低/中 | 已实现 `/quota_nudge <credits|usage_limit> confirm` |
| [ ] | `account/chatgptAuthTokens/refresh` server request | 内部响应流程 | 低 | 只有 app-server 要求 bridge 刷新 token 时才需要 |

## Skills、Hooks、Plugins、Apps

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `skills/list` | `/skills [query]` | 高 | 已实现 |
| [x] | `skills/changed` | 让 `/skills` 缓存失效 | 高 | 已实现通知 |
| [x] | `skills/config/write` | `/skill_enable`、`/skill_disable` | 中 | 已实现 |
| [x] | `hooks/list` | `/hooks` | 中 | 已实现只读列表 |
| [x] | `plugin/list` | `/plugins` | 中 | 已实现只读列表 |
| [x] | `plugin/read` | `/plugin <id>` | 中 | 已实现 manifest、skills、hooks、apps、MCP 摘要 |
| [x] | `plugin/skill/read` | `/plugin_skill <plugin> <skill>` | 中 | 已实现远程 plugin skill markdown 预览 |
| [ ] | `plugin/install` | `/plugin_install <id>` | 低/中 | 仍在开发中；可能改 MCP/app 配置 |
| [ ] | `plugin/uninstall` | `/plugin_uninstall <id>` | 低/中 | 需要确认 |
| [ ] | `marketplace/add` | `/marketplace_add <repo>` | 低 | 会改配置，建议 admin-only |
| [ ] | `marketplace/remove` | `/marketplace_remove <name>` | 低 | 会改配置并删除文件 |
| [ ] | `marketplace/upgrade` | `/marketplace_upgrade [name]` | 低/中 | plugin 浏览器稳定后再做 |
| [ ] | `plugin/share/list/save/updateTargets/delete` | `/plugin_share ...` | 低 | plugin 管理成熟前价值不大 |
| [x] | `app/list`、`app/list/updated` | `/apps` | 中 | 已实现只读列表和变更通知 |

## MCP

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `mcpServerStatus/list` | `/mcp` | 高 | 已实现 |
| [x] | `mcpServer/startupStatus/updated` | 更新 active `/mcp` 面板或通知失败 | 高 | 已实现通知 |
| [x] | `config/mcpServer/reload` | `/mcp_reload` | 高 | 已实现 |
| [x] | `mcpServer/oauth/login` | `/mcp_login <server>` | 高 | 已实现，返回授权 URL |
| [x] | `mcpServer/oauthLogin/completed` | 通知成功/失败 | 高 | 已实现通知 |
| [x] | `mcpServer/resource/read` | `/mcp_resource <server> <uri>` | 中 | 已实现文本/JSON 摘要 |
| [ ] | `mcpServer/tool/call` | `/mcp_call <server> <tool> <json>` | 低/高风险 | 直接调用工具会绕开 agent 判断，建议只做 admin/debug |
| [x] | `mcpServer/elicitation/request` server request | 内联问题卡片/按钮 | 高 | 已实现 |
| [x] | `item/mcpToolCall/progress` | 活动卡展示 MCP 进度 | 中 | 已实现轻量进度状态 |

## Review 和代码检查

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `review/start` | `/review`、`/review base <branch>`、`/review commit <sha>` | 高 | 已实现 |
| [ ] | `enteredReviewMode`、`exitedReviewMode` item types | review 专用渲染 | 中 | 最终 review 文本作为持久消息 |
| [x] | `turn/diff/updated` | `/diff` 或 live “变更”卡片 | 中 | 已实现 `/diff` 读取最近 diff，输出裁剪 |
| [x] | `thread/turns/list` | `/history`、`/history <thread>` | 中 | 已实现当前绑定线程 `/history [limit]` |
| [x] | `fuzzyFileSearch` | `/files <query>` | 低/中 | 已实现当前 cwd 下只读搜索 |
| [ ] | `fuzzyFileSearch/sessionStart/update/stop` 及通知 | 交互式文件选择器 | 低 | UI 工作量比一次性搜索大 |

## 配置和功能开关

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [x] | `config/read` | `/config` | 中 | 已实现安全摘要，不展示完整敏感配置 |
| [x] | `configRequirements/read` | `/requirements` | 中 | 已实现托管约束摘要 |
| [ ] | `config/value/write` | `/config_set <key> <value>` | 低/高风险 | 改用户配置，必须确认且做 allow-list |
| [ ] | `config/batchWrite` | 结构化设置面板的内部 helper | 低/高风险 | 未来 settings UI 可能需要 |
| [x] | `experimentalFeature/list` | `/features` | 中 | 已实现只读列表 |
| [ ] | `experimentalFeature/enablement/set` | `/feature_enable <name>` | 低/高风险 | 进程级运行时修改，建议 admin-only |
| [x] | `modelProvider/capabilities/read` | 合并进 `/models` 或 `/status` | 中 | 已实现 `/provider` |
| [x] | `model/rerouted`、`model/verification` | reroute/验证通知 | 中 | 已实现轻量通知 |

## 文件、命令、进程

这些能力可能有用，但 Telegram 上安全和交互风险更高。

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `command/exec` | `/exec <cmd>` | 低/高风险 | 独立 sandbox 命令；比裸 host process 安全一些 |
| [ ] | `command/exec/write`、`resize`、`terminate` | 交互式 exec 控制 | 低 | 只有支持长时间 PTY 会话时才需要 |
| [ ] | `command/exec/outputDelta` | 流式命令输出 | 低/中 | 需要限速和裁剪 |
| [ ] | `fs/readFile`、`fs/readDirectory`、`fs/getMetadata` | `/ls`、`/cat`、`/stat` | 低/中 | 方便，但 Codex agent 本来也能做 |
| [ ] | `fs/writeFile`、`fs/createDirectory`、`fs/remove`、`fs/copy` | 文件管理命令 | 低/高风险 | 默认不建议；破坏性操作必须确认 |
| [ ] | `fs/watch`、`fs/unwatch`、`fs/changed` | `/watch_file <path>` | 低 | 文件变更通知可能很吵 |
| [ ] | `process/spawn`、`process/writeStdin`、`process/resizePty`、`process/kill` | host process 控制 | 很低/高风险 | README 提到实验 API；本次检查的 generated ClientRequest 方法表里未出现，按不稳定处理 |
| [ ] | `process/outputDelta`、`process/exited` | 进程输出流 | 很低 | 只有采用 process API 后才需要 |
| [ ] | `thread/shellCommand` | `!cmd` | 低/高风险 | 上游说明是 unsandboxed full access，默认不要开 |
| [ ] | `thread/backgroundTerminals/clean` | `/terminals_clean` | 低 | 如果以后展示 background terminals，再做清理入口 |

## Realtime 和远程环境

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `thread/realtime/start` | `/voice_start` 或 live text session | 低/实验 | Telegram 语音需要音频转码和会话生命周期 UI |
| [ ] | `thread/realtime/appendAudio` | 转发 Telegram voice message | 低/实验 | 需要解码/转码成上游期望的音频 chunk |
| [ ] | `thread/realtime/appendText` | realtime 期间追加文本 | 低 | 和 `turn/steer` 重叠 |
| [ ] | `thread/realtime/stop` | `/voice_stop` | 低 | 只有做 realtime 时需要 |
| [ ] | `thread/realtime/listVoices` | `/voices` | 低 | 只有做音频输出时需要 |
| [ ] | `thread/realtime/*` notifications | transcript/audio 渲染 | 低 | 音频 chunk 不太适合 Telegram bot |
| [x] | `remoteControl/status/changed` | `/remote` 状态 | 中 | 已实现最近状态缓存和变化通知 |
| [ ] | `environment/add` | `/environment_add ...` | 低 | 实验性远程环境注册 |

## 外部 Agent 迁移

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `externalAgentConfig/detect` | `/import_detect` | 低/中 | 检测其他 agent 工具可迁移的 artifacts |
| [ ] | `externalAgentConfig/import` | `/import_apply` | 低/高风险 | 会改 config/skills/plugins/sessions，需要明确选择和确认 |
| [ ] | `externalAgentConfig/import/completed` | 通知导入完成 | 低 | 如果做 import 就需要 |

## Feedback、Attestation、平台特定能力

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `feedback/upload` | `/feedback <text>` | 低 | 可附日志，但有隐私风险 |
| [ ] | `attestation/generate` server request | 内部响应 | 低 | 只有未来某个流程需要 attestation 时再做 |
| [ ] | `windowsSandbox/readiness` | `/windows_sandbox` | 低 | 只对 Windows host 有用 |
| [ ] | `windowsSandbox/setupStart`、`windowsSandbox/setupCompleted` | `/windows_sandbox_setup` | 低/高风险 | 平台特定 setup 命令 |
| [ ] | `windows/worldWritableWarning` | warning 通知 | 低 | 只对 Windows 有用 |

## 需要支持的 Server Requests

Server request 很重要，因为如果 bridge 不支持，Codex 可能在 turn 中途失败或能力缺失。

| 勾选 | Server request | 当前状态 | Telegram 桥接想法 | 优先级 |
| --- | --- | --- | --- | --- |
| [x] | `item/commandExecution/requestApproval` | 已实现 | 现有内联审批 | 已完成 |
| [x] | `item/fileChange/requestApproval` | 已实现 | 现有内联审批 | 已完成 |
| [x] | `item/tool/requestUserInput` | 已实现 | 现有按钮/文本回答 | 已完成 |
| [x] | `item/permissions/requestApproval` | 已实现 | 细粒度权限审批卡片 | 已完成 |
| [x] | `mcpServer/elicitation/request` | 已实现 | MCP 问题卡片 | 已完成 |
| [ ] | `item/tool/call` | 缺失 | 动态工具执行桥接 | 低/实验 |
| [ ] | `account/chatgptAuthTokens/refresh` | 缺失 | 如果 app-server 委托客户端刷新 token，则响应它 | 低 |
| [ ] | `attestation/generate` | 缺失 | 生成或拒绝 attestation | 低 |
| [ ] | 旧版 `execCommandApproval`、`applyPatchApproval` | 缺失 | 仅做旧协议兼容 | 低 |

## 值得渲染的 Notifications

| 勾选 | Notification | Telegram 用途 | 优先级 |
| --- | --- | --- | --- |
| [x] | `thread/status/changed` | 更新 `/threads`、`/where`、活动卡片 | 已完成轻量通知 |
| [x] | `thread/name/updated` | 同步重命名到线程缓存 | 已完成 |
| [x] | `thread/archived`、`thread/unarchived`、`thread/closed` | 线程生命周期通知 | 已完成 |
| [x] | `thread/tokenUsage/updated` | 实时 token/成本卡片 | 已完成高水位提醒 |
| [x] | `turn/diff/updated` | 当前 diff/变更视图 | 已完成 |
| [ ] | `item/reasoning/summaryTextDelta`、`summaryPartAdded` | 更好的 reasoning summary 渲染 | 低/中 |
| [ ] | `item/commandExecution/outputDelta` | 命令输出片段实时显示 | 中 |
| [ ] | `item/fileChange/patchUpdated` | 更好的 live edit 摘要 | 中 |
| [x] | `item/mcpToolCall/progress` | MCP progress 状态 | 中 |
| [x] | `serverRequest/resolved` | 更可靠地清理审批/问题卡片 | 已完成 |
| [x] | `account/updated`、`account/login/completed`、`account/rateLimits/updated` | 账号面板和额度提醒 | 已完成 |
| [x] | `skills/changed` | skills 列表缓存失效 | 已完成 |
| [x] | `mcpServer/startupStatus/updated`、`mcpServer/oauthLogin/completed` | MCP 诊断和 OAuth 结果 | 已完成 |
| [x] | `app/list/updated` | connector 列表刷新 | 已完成 |
| [x] | `remoteControl/status/changed` | remote control 状态 | 中 |
| [x] | `warning`、`configWarning`、`guardianWarning`、`deprecationNotice` | 管理/状态 warning | 已完成轻量通知 |

## 建议实现顺序

1. `turn/steer`（已完成）
   - 已增加 `CodexAppClient.steerTurn()`。
   - 已增加 `/steer <text>`。
   - 当前采用显式 `/steer`，active turn 期间普通文本继续沿用现有 queue/takeover 语义。

2. 登录和账号面板（已完成）
   - 已增加原生 `/account`、`/login_device`、`/login_cancel`、`/logout confirm`、`/quota`、`/quota_nudge`。
   - `/auth add <name>` 会先把 `auth.json` 指向新的候选文件，再启动 device-code 登录，登录完成后可继续用 `/auth` 切换。
   - 保留当前 `/auth` auth 文件轮换，作为高级/本地 fallback。

3. Skills 和 MCP 面板（已完成）
   - 已增加 `/skills`、`/skill`、`/skill_enable`、`/skill_disable`、`/mcp`、`/mcp_reload`、`/mcp_login`、`/mcp_resource`。
   - 已支持 `skills/changed`、MCP startup、OAuth completion 通知。

4. 补缺失的 server requests（已完成）
   - 已增加 `item/permissions/requestApproval`。
   - 已增加 `mcpServer/elicitation/request`。

5. 线程管理和 review（已完成）
   - 已增加 `/rename`、`/fork`、`/undo`、`/compact`、`/archive`、`/unarchive`、`/review`、`/diff`。
   - 已补生命周期通知和 diff 缓存/展示。

6. 低优先级管理面和实验面（部分已完成）
   - 已完成只读 Plugins、apps、config/requirements/features/provider 诊断面。
   - 仍未实现：config 写入、直接 command/fs/process、realtime、外部 agent import。
