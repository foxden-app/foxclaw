# Telegram Rich Message 适配专项检查

检查日期：2026-06-16。依据：Telegram Bot API Rich Messages 文档，尤其是 `RichMessage`、`sendRichMessage`、`sendRichMessageDraft` 与 Rich Message Formatting Options。

官方入口：

- https://core.telegram.org/bots/api#rich-message-formatting-options
- https://core.telegram.org/bots/api#sendrichmessage
- https://core.telegram.org/bots/api#sendrichmessagedraft

## 结论

FoxClaw 有明确收益，并已开始把 RichMessage 用在适合看效果、可安全回退的 Telegram 功能面。

现在的策略是：Telegram 优先尝试 `sendRichMessage`，失败时回退到既有 Telegram HTML；微信继续使用 HTML/plain 回退。Bot API 10.1 的 Rich Message 先用于可观察的诊断和结构化长文本，再逐步扩展到状态、auth/quota 和 AI draft streaming。

本次已先落地低风险增强：

- 新增 `src/telegram/html.ts`，统一 Telegram HTML 转义和常用标签生成。
- 新增 `src/telegram/rich.ts`，并在 `TelegramGateway` / `TelegramMessagingPort` / `BridgeMessagingRouter` 接入 `sendRichMessage` / rich HTML 发送链路。
- 新增 `/rich` 诊断命令，用来在真实 Telegram 客户端查看 heading、table、details、pre/code、list 的 RichMessage 效果。
- `/diff` 改为优先发送 RichMessage：标题用 heading，diff 内容放入 details + pre/code；rich 发送失败时回退到 HTML 加粗标题和可展开引用块。
- 现有 CLI 观察消息和归档工具批次状态复用同一套 HTML helper。

## 官方能力摘录

Bot API 10.1 新增 Rich Messages：

- `RichText*`：bold、italic、underline、strikethrough、spoiler、code、marked、math、url、email、phone、mention、hashtag、bot command、anchor/reference 等。
- `RichBlock*`：paragraph、heading、pre、footer、divider、math block、anchor、list、blockquote、pullquote、collage、slideshow、table、details、map、photo/video/audio/animation/voice、thinking。
- `sendRichMessage`：发送完整 rich message。
- `sendRichMessageDraft`：在私聊里流式发送临时 rich draft；draft 是短暂预览，最终仍要用 `sendRichMessage` 发送完整消息。
- `editMessageText` 新增 `rich_message` 参数，可编辑 rich message。

Rich Message HTML 还支持 `<details>`、`<table>`、`<pre><code class="language-...">`、`<ul>/<ol>`、`<hr/>`、`<tg-math-block>`、`<tg-thinking>` 等标签。`RichBlockThinking` 只能用于 `sendRichMessageDraft`。

## FoxClaw 现状

当前 Telegram 发送层：

- `src/telegram/gateway.ts`：`sendMessage`、`sendHtmlMessage`、`sendRichMessage`、`editMessage`、`editHtmlMessage`、`editRichMessage` 已接入；HTML 普通消息使用 `parse_mode=HTML`，rich 消息使用 `rich_message.html`。
- `src/channels/telegram/telegram_messaging_port.ts`：对 controller 暴露 plain/html/rich-html send/edit 和 `sendDraft`。
- `src/telegram/rendering.ts`：默认 `segmented_stream`；`draft_stream` 仍是旧 `sendMessageDraft` 文本 draft。
- `src/controller/controller.ts`：状态卡、审批、工具批次、diff、auth、MCP、插件、文件等功能面都在这里汇总发送。
- `src/controller/presentation.ts`：`/threads`、`/setup`、模型/权限面板已经使用 Telegram HTML。

已经使用的格式能力：

- `/threads`、`/setup` 等面板：加粗、code、HTML escape。
- CLI 观察消息：`<pre>`。
- 归档工具批次状态：`<blockquote expandable>`。
- 本次增强后的 `/diff`：加粗标题和可展开引用块。

已经接入：

- `sendRichMessage`：Telegram rich HTML 发送链路。
- `/rich`：RichMessage demo。
- `/diff`：RichMessage details + diff pre/code，失败回退 HTML。

尚未接入：

- Rich table/status 面板、auth/quota 表格、MCP resource details、rich draft streaming。
- `sendRichMessageDraft` 的 thinking block 和最终 rich message 持久化。

## 功能面盘点

| 功能面 | 现状 | 可用 rich 能力 | 建议 |
| --- | --- | --- | --- |
| 活动 turn 状态卡 | 普通短文本，频繁编辑 | heading、list、thinking draft | 保持普通状态卡稳定；私聊 draft streaming 后续用 `RichBlockThinking` |
| Codex streaming 回复 | 分段纯文本为主 | rich draft、paragraph、pre、details | 先不默认切；需要 feature flag 和失败回退 |
| 归档工具批次 | 已用 expandable blockquote | details、pre、list | 短期维持 HTML；后续 rich details 展开命令、文件、搜索结果 |
| `/diff` | 已优先 RichMessage，失败回退 HTML | pre language、details | 已落地 |
| 审批请求 | 多行纯文本 + inline keyboard | code、pre、spoiler、details | 命令、路径、patch 适合 code/pre/details；敏感参数可 spoiler |
| `/status` / runtime 摘要 | 纯文本列表 | table、heading、footer | 多 bot、多 auth、多 quota 适合 rich table |
| `/auth` / `/quota` | 紧凑纯文本 + 按钮 | table、marked、spoiler | quota 窗口适合 table；异常候选用 marked；隐藏敏感候选信息需谨慎 |
| `/threads` / `/setup` | 已用 HTML 面板 | heading、list、anchor | 现状够用；rich message 价值中等 |
| MCP resource / plugin skill | 纯文本长内容 | details、pre、anchor/reference | schema、resource 文本可放 details/pre，引用可用 anchor/reference |
| 说明类消息 / help | 纯文本 | heading、list、code | 可转 rich list，但优先级低 |
| 媒体附件反馈 | 纯文本摘要 | collage/slideshow/photo/video caption | 只在需要回显媒体结果时考虑，当前不是主路径 |

## 落地路线

### Phase 1：HTML 兼容增强

目标：不改变 Bot API 主方法，先改善现有客户端体验。

- 统一 Telegram HTML helper，禁止散落手写转义。
- 长内容默认折叠：diff、工具日志、MCP resource、插件 skill 内容。
- 命令、路径、模型、候选名使用 `<code>`。
- 对可能包含 secret/token 的诊断内容使用 `<tg-spoiler>` 或直接不展示。

已完成：HTML helper、`/diff` 折叠、现有 CLI/工具归档复用 helper。

### Phase 2：Rich Message builder

目标：让 rich message 作为可回退能力存在，而不是替换全部消息。

已完成：

- 新增 `src/telegram/rich.ts`，定义 `InputRichMessage` 的最小 HTML 输入。
- `TelegramGateway` 增加 `sendRichMessage`、`editRichMessage`、`sendRichMessageDraft`。
- `TelegramMessagingPort` 和 `BridgeMessagingRouter` 增加 rich HTML send/edit；微信 scope 自动用 fallback HTML。
- `/rich` 和 `/diff` 先使用 rich 发送，失败回退到 HTML。

下一步：

- 把 `/status`、`/auth`、`/quota`、MCP resource 等结构消息迁移到 rich table/details。
- 按真实客户端表现决定是否加入全局配置开关。

### Phase 3：Rich draft streaming

目标：私聊里的 AI 生成过程更自然。

- 仅对 Telegram 私聊启用；群组、topic 默认继续走现有 segmented stream。
- draft 中使用 `RichBlockThinking` 表示思考中，已生成文本用 paragraph/pre/details。
- 生成完成后调用 `sendRichMessage` 发送完整消息，不能只依赖 ephemeral draft。
- 保留旧 `sendMessageDraft` 和 plain segmented stream 回退。

## 风险和注意点

- Rich Messages 是 2026-06-11 Bot API 10.1 新能力，客户端兼容性需要通过 `/rich` 和 `/diff` 实测。
- `sendRichMessageDraft` 只面向用户私聊；FoxClaw 的群组、topic、多 bot 场景必须保留旧路径。
- Rich media block 需要 bot 具备对应发送权限，且媒体 URL/上传处理比文本复杂，暂不作为第一阶段目标。
- 自动实体识别可能把路径、邮箱、URL、命令误识别；rich builder 应按消息类型决定是否设置 `skip_entity_detection`。
- HTML/rich 格式必须集中 escape，不能让 Codex 输出或 shell 输出直接拼进标签。
