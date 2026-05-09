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
| Codex App 同步 | Codex deep link，不是 app-server RPC | `/reveal`、`/focus`、`/open` 后同步 |
| 审批 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` | Telegram 内联审批按钮 |
| 工具向用户提问 | `item/tool/requestUserInput` | Telegram 按钮和文本回复 |
| 观察外部 turn | `thread/read` 加 session log fallback | `/watch`、`/unwatch` |
| turn 控制辅助 | bridge 本地控制逻辑 | `/takeover`、`/queue` |

## 优先候选短名单

这些是最值得先考虑的 Telegram 候选：手机端有用、API 相对成熟、Telegram UI 也能承载。

| 勾选 | 候选功能 | 上游 API | 建议 Telegram 入口 | 价值 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 运行中补充指令 | `turn/steer` | `/steer <message>`，也可以考虑 active turn 期间普通消息自动 steer | 可以在 Codex 还在跑时追加约束或纠正，不用 interrupt 或 queue | 如果 active turn 不可 steer，应回退到当前“已有 turn 正在运行”的行为 |
| [ ] | 原生登录管理 | `account/login/start`、`account/login/cancel`、`account/logout`、`account/login/completed`、`account/updated` | `/login`、`/login_device`、`/logout`、`/account` | 用 app-server 官方登录流替代或补充当前 `auth.json_*` 文件切换 | Telegram 上最适合 device-code 登录；API key 登录有聊天记录泄密风险，需要强确认 |
| [ ] | 账号额度操作 | `account/rateLimits/read`、`account/rateLimits/updated`、`account/sendAddCreditsNudgeEmail` | `/quota`、`/quota_notify_owner` | 不打开桌面也能看 quota 和触发额度提醒 | `/status` 已有部分额度信息；发送邮件提醒是新功能，必须显式操作 |
| [ ] | Skills 浏览器 | `skills/list`、`skills/changed`、`skills/config/write` | `/skills`、`/skill <name>`、`/skill_enable`、`/skill_disable` | 远程查看和管理 Codex skills | 建议先做只读列表，再做启用/禁用 |
| [ ] | MCP 状态面板 | `mcpServerStatus/list`、`mcpServer/startupStatus/updated`、`config/mcpServer/reload` | `/mcp`、`/mcp_reload` | 远程排查工具不可用、MCP 启动失败、认证失败 | 非常适合用紧凑状态消息展示 |
| [ ] | MCP OAuth 登录 | `mcpServer/oauth/login`、`mcpServer/oauthLogin/completed` | `/mcp_login <server>` | 从 Telegram 修复 connector/MCP 认证 | 发送授权 URL，并在完成后回报结果 |
| [ ] | MCP 资源读取 | `mcpServer/resource/read` | `/mcp_resource <server> <uri>` | 直接读取 MCP server 提供的上下文资源 | 文本好处理；二进制需要裁剪或只显示元信息 |
| [ ] | MCP elicitation | `mcpServer/elicitation/request` | active turn 期间内联问题卡片/按钮 | 有些 MCP server 会中途向用户要结构化输入，不支持会卡住能力 | UI 可复用现有 `requestUserInput` 思路 |
| [ ] | 细粒度权限请求 | `item/permissions/requestApproval` | 内联权限审批卡片 | 新版 granular permissions 需要这个，否则部分流程会失败 | 要清晰展示文件/网络权限范围 |
| [ ] | 代码审查 | `review/start` | `/review`、`/review base <branch>`、`/review commit <sha>` | 手机端很适合触发 review，然后阅读 findings | 复用现有 turn 渲染，加 review 专用状态即可 |
| [ ] | fork 线程 | `thread/fork` | `/fork [name]` | 在尝试高风险路径前复制一份对话分支 | 成功后建议把 Telegram 绑定到新 fork |
| [ ] | rollback 线程 | `thread/rollback` | `/undo [n]` 或 `/rollback [n]` | 从上下文中移除最近坏 turn | `n > 1` 建议二次确认 |
| [ ] | 重命名线程 | `thread/name/set`、`thread/name/updated` | `/rename <name>` | 让 `/threads` 更容易浏览 | 低风险、高体验收益 |
| [ ] | 手动压缩上下文 | `thread/compact/start` | `/compact` | 手机端继续长线程前主动压缩上下文 | 进度通过普通 turn/item 事件回来 |
| [ ] | 归档/取消归档线程 | `thread/archive`、`thread/unarchive` 及通知 | `/archive`、`/unarchive <n>` | 远程整理线程列表 | 当前 `/threads` 隐藏 archived，需要新增 archived 列表模式 |
| [ ] | 完整 diff 展示 | `turn/diff/updated` | 实时或最终“变更”卡片 | 不只靠工具摘要，也能看到本轮实际改动 | diff 可能很长，需要裁剪 |

## 线程和 Turn 管理

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `turn/steer` | `/steer <message>` 或 active-turn 普通文本自动 steer | 高 | 你明确提到想要 |
| [ ] | `thread/fork` | `/fork [name]` | 高 | 很适合试不同方案 |
| [ ] | `thread/rollback` | `/undo [n]`、`/rollback [n]` | 高 | 需要确认和 active-turn guard |
| [ ] | `thread/name/set` | `/rename <name>` | 高 | 同时监听 `thread/name/updated` |
| [ ] | `thread/archive` | `/archive` | 中 | 如果归档当前线程，应停止 watch 并清理绑定 |
| [ ] | `thread/unarchive` | `/threads archived`、`/unarchive <n>` | 中 | 需要 archived 线程列表 |
| [ ] | `thread/compact/start` | `/compact` | 中 | 长上下文时有用 |
| [ ] | `thread/loaded/list` | `/loaded` 或合并进 `/status` | 低 | 主要是诊断 |
| [ ] | `thread/unsubscribe` | watch/open 切换后的内部清理 | 低 | 如果以后改成原生订阅，可减少 app-server 订阅 |
| [ ] | `thread/metadata/update` | 暂不做直接用户命令 | 低 | 目前主要是 git metadata |
| [ ] | `thread/inject_items` | 高级导入/调试命令 | 低 | 容易误用，不像普通 Telegram 功能 |
| [ ] | `thread/shellCommand` | `/shell <cmd>` 或 `!cmd` | 低/高风险 | 上游说明它是 unsandboxed full access，默认不建议开 |
| [ ] | `thread/approveGuardianDeniedAction` | 内联“仍然执行”流程 | 低 | 需要仔细研究 guardian 语义 |

## Goal 和 Memory

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `thread/goal/set` | `/goal <objective>`、`/goal_pause`、`/goal_done` | 中 | 实验能力，但对长任务有用 |
| [ ] | `thread/goal/get` | `/goal` | 中 | 展示目标、状态、预算、用量 |
| [ ] | `thread/goal/clear` | `/goal_clear` | 中 | 建议确认 |
| [ ] | `thread/goal/updated`、`thread/goal/cleared` | 被动状态更新 | 中 | 只有做 goal 命令后才有意义 |
| [ ] | `thread/memoryMode/set` | `/memory on`、`/memory off` | 低/中 | 实验能力；只有目标 Codex 开启 memories 时有价值 |
| [ ] | `memory/reset` | `/memory_reset` | 低/高风险 | 破坏性操作，必须强确认 |

## 登录、账号、额度

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `account/read` | `/account` | 高 | `/status` 已部分展示；可以做一个专门的简洁视图 |
| [ ] | `account/login/start` with `chatgptDeviceCode` | `/login_device` | 高 | 最适合 Telegram：显示设备登录 URL 和 code |
| [ ] | `account/login/start` with `chatgpt` | `/login_browser` | 中 | 对桌面宿主机有用，从手机触发价值稍低 |
| [ ] | `account/login/start` with `apiKey` | `/login_api_key` | 低/高风险 | 除非强需求，否则不建议；密钥会留在聊天记录 |
| [ ] | `account/login/cancel` | `/login_cancel` | 中 | 做登录流就需要取消入口 |
| [ ] | `account/logout` | `/logout` | 中 | 需要确认 |
| [ ] | `account/login/completed`、`account/updated` | 通知登录/登出结果 | 高 | 登录 UX 必需 |
| [ ] | `account/rateLimits/read`、`account/rateLimits/updated` | `/quota` | 高 | `/status` 已部分展示；可以做更完整的额度页 |
| [ ] | `account/sendAddCreditsNudgeEmail` | `/quota_notify_owner` | 低/中 | 对 workspace 用户有用；必须显式确认 |
| [ ] | `account/chatgptAuthTokens/refresh` server request | 内部响应流程 | 低 | 只有 app-server 要求 bridge 刷新 token 时才需要 |

## Skills、Hooks、Plugins、Apps

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `skills/list` | `/skills [query]` | 高 | 你明确提到想要 |
| [ ] | `skills/changed` | 让 `/skills` 缓存失效 | 高 | 收到变更通知后，下次按需重新 list |
| [ ] | `skills/config/write` | `/skill_enable`、`/skill_disable` | 中 | 先做只读 skills，再做写配置 |
| [ ] | `hooks/list` | `/hooks` | 中 | 适合排查 hook 行为 |
| [ ] | `plugin/list` | `/plugins` | 中 | 上游标注插件 API 还在开发中，建议先只读 |
| [ ] | `plugin/read` | `/plugin <id>` | 中 | 展示 manifest、skills、hooks、apps、MCP 摘要 |
| [ ] | `plugin/skill/read` | `/plugin_skill <plugin> <skill>` | 中 | 预览远程 plugin skill markdown |
| [ ] | `plugin/install` | `/plugin_install <id>` | 低/中 | 仍在开发中；可能改 MCP/app 配置 |
| [ ] | `plugin/uninstall` | `/plugin_uninstall <id>` | 低/中 | 需要确认 |
| [ ] | `marketplace/add` | `/marketplace_add <repo>` | 低 | 会改配置，建议 admin-only |
| [ ] | `marketplace/remove` | `/marketplace_remove <name>` | 低 | 会改配置并删除文件 |
| [ ] | `marketplace/upgrade` | `/marketplace_upgrade [name]` | 低/中 | plugin 浏览器稳定后再做 |
| [ ] | `plugin/share/list/save/updateTargets/delete` | `/plugin_share ...` | 低 | plugin 管理成熟前价值不大 |
| [ ] | `app/list`、`app/list/updated` | `/apps` | 中 | 查看 connector；以后可支持 app mention 输入 |

## MCP

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `mcpServerStatus/list` | `/mcp` | 高 | 你明确提到想要 |
| [ ] | `mcpServer/startupStatus/updated` | 更新 active `/mcp` 面板或通知失败 | 高 | 很适合远程诊断 |
| [ ] | `config/mcpServer/reload` | `/mcp_reload` | 高 | 不重启 bridge 也能 reload config |
| [ ] | `mcpServer/oauth/login` | `/mcp_login <server>` | 高 | 返回授权 URL |
| [ ] | `mcpServer/oauthLogin/completed` | 通知成功/失败 | 高 | OAuth UX 必需 |
| [ ] | `mcpServer/resource/read` | `/mcp_resource <server> <uri>` | 中 | 文本资源适合 Telegram；blob 需要裁剪/元信息 |
| [ ] | `mcpServer/tool/call` | `/mcp_call <server> <tool> <json>` | 低/高风险 | 直接调用工具会绕开 agent 判断，建议只做 admin/debug |
| [ ] | `mcpServer/elicitation/request` server request | 内联问题卡片/按钮 | 高 | MCP 工具向用户提问时必需 |
| [ ] | `item/mcpToolCall/progress` | 活动卡展示 MCP 进度 | 中 | 更接近 Codex App 的状态展示 |

## Review 和代码检查

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `review/start` | `/review`、`/review base <branch>`、`/review commit <sha>` | 高 | 很适合 Telegram 触发和阅读 |
| [ ] | `enteredReviewMode`、`exitedReviewMode` item types | review 专用渲染 | 中 | 最终 review 文本作为持久消息 |
| [ ] | `turn/diff/updated` | `/diff` 或 live “变更”卡片 | 中 | 改文件后有用；diff 要裁剪 |
| [ ] | `thread/turns/list` | `/history`、`/history <thread>` | 中 | 不 resume 线程也能读历史 |
| [ ] | `fuzzyFileSearch` | `/files <query>` | 低/中 | 从 Telegram 选择路径时有用 |
| [ ] | `fuzzyFileSearch/sessionStart/update/stop` 及通知 | 交互式文件选择器 | 低 | UI 工作量比一次性搜索大 |

## 配置和功能开关

| 勾选 | API | Telegram 想法 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| [ ] | `config/read` | `/config` | 中 | 当前内部已用一部分；可暴露安全摘要 |
| [ ] | `configRequirements/read` | `/requirements` | 中 | 展示托管约束、允许的 policy、网络规则 |
| [ ] | `config/value/write` | `/config_set <key> <value>` | 低/高风险 | 改用户配置，必须确认且做 allow-list |
| [ ] | `config/batchWrite` | 结构化设置面板的内部 helper | 低/高风险 | 未来 settings UI 可能需要 |
| [ ] | `experimentalFeature/list` | `/features` | 中 | 看 apps/plugins/memories 等是否可用 |
| [ ] | `experimentalFeature/enablement/set` | `/feature_enable <name>` | 低/高风险 | 进程级运行时修改，建议 admin-only |
| [ ] | `modelProvider/capabilities/read` | 合并进 `/models` 或 `/status` | 中 | 解释 provider 限制 |
| [ ] | `model/rerouted`、`model/verification` | reroute/验证通知 | 中 | 解释为什么模型被切换或需要额外验证 |

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
| [ ] | `remoteControl/status/changed` | `/remote` 状态 | 中 | 如果启用 remote control，会有诊断价值 |
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
| [ ] | `item/permissions/requestApproval` | 缺失 | 细粒度权限审批卡片 | 高 |
| [ ] | `mcpServer/elicitation/request` | 缺失 | MCP 问题卡片 | 高 |
| [ ] | `item/tool/call` | 缺失 | 动态工具执行桥接 | 低/实验 |
| [ ] | `account/chatgptAuthTokens/refresh` | 缺失 | 如果 app-server 委托客户端刷新 token，则响应它 | 低 |
| [ ] | `attestation/generate` | 缺失 | 生成或拒绝 attestation | 低 |
| [ ] | 旧版 `execCommandApproval`、`applyPatchApproval` | 缺失 | 仅做旧协议兼容 | 低 |

## 值得渲染的 Notifications

| 勾选 | Notification | Telegram 用途 | 优先级 |
| --- | --- | --- | --- |
| [ ] | `thread/status/changed` | 更新 `/threads`、`/where`、活动卡片 | 中 |
| [ ] | `thread/name/updated` | 同步重命名到线程缓存 | 如果做 `/rename` 则高 |
| [ ] | `thread/archived`、`thread/unarchived`、`thread/closed` | 线程生命周期通知 | 中 |
| [ ] | `thread/tokenUsage/updated` | 实时 token/成本卡片 | 中 |
| [ ] | `turn/diff/updated` | 当前 diff/变更视图 | 中 |
| [ ] | `item/reasoning/summaryTextDelta`、`summaryPartAdded` | 更好的 reasoning summary 渲染 | 低/中 |
| [ ] | `item/commandExecution/outputDelta` | 命令输出片段实时显示 | 中 |
| [ ] | `item/fileChange/patchUpdated` | 更好的 live edit 摘要 | 中 |
| [ ] | `item/mcpToolCall/progress` | MCP progress 状态 | 中 |
| [ ] | `serverRequest/resolved` | 更可靠地清理审批/问题卡片 | 中 |
| [ ] | `account/updated`、`account/login/completed`、`account/rateLimits/updated` | 账号面板和额度提醒 | 如果做登录管理则高 |
| [ ] | `skills/changed` | skills 列表缓存失效 | 如果做 skills browser 则高 |
| [ ] | `mcpServer/startupStatus/updated`、`mcpServer/oauthLogin/completed` | MCP 诊断和 OAuth 结果 | 如果做 MCP browser 则高 |
| [ ] | `app/list/updated` | connector 列表刷新 | 如果做 apps browser 则中 |
| [ ] | `remoteControl/status/changed` | remote control 状态 | 中 |
| [ ] | `warning`、`configWarning`、`guardianWarning`、`deprecationNotice` | 管理/状态 warning | 中 |

## 建议实现顺序

1. `turn/steer`
   - 增加 `CodexAppClient.steerTurn()`。
   - 增加 `/steer <text>`。
   - 决定 active-turn 普通文本是自动 steer，还是必须显式 `/steer`。

2. 登录和账号面板
   - 增加原生 `/account`、`/login_device`、`/login_cancel`、`/logout`、`/quota`。
   - 保留当前 `/auth` auth 文件轮换，作为高级/本地 fallback。

3. Skills 和 MCP 只读面板
   - 增加 `/skills`、`/mcp`、`/mcp_reload`、`/mcp_login`。
   - 支持 `skills/changed`、MCP startup、OAuth completion 通知。

4. 补缺失的 server requests
   - 增加 `item/permissions/requestApproval`。
   - 增加 `mcpServer/elicitation/request`。

5. 线程管理和 review
   - 增加 `/rename`、`/fork`、`/undo`、`/compact`、`/review`。
   - 按这些命令需要，再补生命周期和 diff 渲染。

6. 低优先级管理面和实验面
   - Plugins、apps、config 写入、直接 command/fs/process、realtime、外部 agent import。
