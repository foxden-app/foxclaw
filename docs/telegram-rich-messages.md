# Telegram Rich Message Adaptation Check

Checked on 2026-06-16 against Telegram Bot API Rich Messages, especially `RichMessage`, `sendRichMessage`, `sendRichMessageDraft`, and Rich Message Formatting Options.

Official references:

- https://core.telegram.org/bots/api#rich-message-formatting-options
- https://core.telegram.org/bots/api#sendrichmessage
- https://core.telegram.org/bots/api#sendrichmessagedraft

## Conclusion

FoxClaw can benefit from the new rich message surface, and RichMessage is now wired into Telegram surfaces that are easy to inspect and safe to fall back.

The current strategy is to try `sendRichMessage` first on Telegram, then fall back to the existing Telegram HTML path on failure. Weixin continues to use HTML/plain fallback. Bot API 10.1 Rich Messages start with diagnostics and structured long text, then can expand to status, auth/quota, and AI draft streaming.

Already landed in this pass:

- Added `src/telegram/html.ts` for centralized Telegram HTML escaping and tag helpers.
- Added `src/telegram/rich.ts` and wired `sendRichMessage` / rich HTML through `TelegramGateway`, `TelegramMessagingPort`, and `BridgeMessagingRouter`.
- Added `/rich` as a diagnostic command for checking heading, table, details, pre/code, and list rendering in a real Telegram client.
- Changed `/diff` to prefer RichMessage with a heading plus details/pre/code diff block, falling back to HTML bold title plus expandable quote body.
- Moved existing CLI observation and archived tool-batch HTML generation onto the shared helper.

## Official Capability

Bot API 10.1 adds Rich Messages:

- `RichText*`: bold, italic, underline, strikethrough, spoiler, code, marked, math, URL, email, phone, mention, hashtag, bot command, anchors, and references.
- `RichBlock*`: paragraph, heading, preformatted, footer, divider, math block, anchor, list, block quote, pull quote, collage, slideshow, table, details, map, media blocks, and thinking.
- `sendRichMessage`: sends a complete rich message.
- `sendRichMessageDraft`: streams an ephemeral partial rich message in private chat; the final answer must still be persisted with `sendRichMessage`.
- `editMessageText` accepts `rich_message` for editing rich messages.

Rich Message HTML also supports tags such as `<details>`, `<table>`, `<pre><code class="language-...">`, `<ul>/<ol>`, `<hr/>`, `<tg-math-block>`, and `<tg-thinking>`. `RichBlockThinking` is draft-only.

## FoxClaw Inventory

Current Telegram send layer:

- `src/telegram/gateway.ts`: plain/html/rich send and edit are wired; regular HTML uses `parse_mode=HTML`, while rich messages use `rich_message.html`.
- `src/channels/telegram/telegram_messaging_port.ts`: controller-facing plain/html/rich-html send/edit and text draft operations.
- `src/telegram/rendering.ts`: `segmented_stream` is the default; `draft_stream` still uses the old text draft path.
- `src/controller/controller.ts`: central dispatcher for status cards, approvals, tool batches, diffs, auth, MCP, plugins, files, and runtime summaries.
- `src/controller/presentation.ts`: `/threads`, `/setup`, model, and access panels already use Telegram HTML.

Useful mapping:

| Surface | Current state | Useful rich capabilities | Recommendation |
| --- | --- | --- | --- |
| Active turn status | Short plain text, frequent edits | heading, list, thinking draft | Keep stable; use `RichBlockThinking` later only for private draft streaming |
| Codex streaming replies | Segmented plain text | rich draft, paragraph, pre, details | Feature flag only; needs fallback |
| Archived tool batches | Expandable HTML quote | details, pre, list | Keep HTML now; later use rich details |
| `/diff` | RichMessage first, HTML fallback | pre language, details | Landed |
| Approvals | Plain text plus inline keyboard | code, pre, spoiler, details | Command/path/patch fit code/pre/details; sensitive params should be hidden |
| `/status` and runtime summaries | Plain text lists | table, heading, footer | Good candidate for rich tables |
| `/auth` and `/quota` | Compact text plus buttons | table, marked, spoiler | Quota windows fit tables; abnormal candidates fit marked text |
| `/threads` and `/setup` | HTML panels | heading, list, anchor | Current HTML is enough; medium priority |
| MCP resources and plugin skills | Long plain text | details, pre, anchor/reference | Good candidate for collapsible schema/resource blocks |
| Help and setup text | Plain text | heading, list, code | Low priority |
| Media attachment feedback | Plain summary | collage/slideshow/media captions | Use only if FoxClaw starts returning media previews |

## Rollout Plan

Phase 1: HTML-compatible enhancement.

- Centralize Telegram HTML helpers.
- Collapse long content by default: diffs, tool logs, MCP resources, plugin skill contents.
- Render commands, paths, models, and candidate names as code.
- Use spoilers or omission for secret/token-like diagnostics.

Phase 2: Rich Message builder.

Done:

- Added a minimal typed `src/telegram/rich.ts`.
- Added `sendRichMessage`, `editRichMessage`, and `sendRichMessageDraft` to `TelegramGateway`.
- Added rich HTML send/edit to `TelegramMessagingPort` and `BridgeMessagingRouter`; Weixin scopes use fallback HTML.
- `/rich` and `/diff` use rich sending first and fall back to HTML.

Next:

- Move `/status`, `/auth`, `/quota`, and MCP resources to rich table/details.
- Decide whether a global config flag is needed after real Telegram client checks.

Phase 3: Rich draft streaming.

- Enable only in Telegram private chats first; keep group/topic rendering on the current segmented stream.
- Use `RichBlockThinking` while generating and paragraph/pre/details for partial output.
- Persist the final answer with `sendRichMessage`.
- Keep the old text draft and segmented stream as fallback paths.

## Risks

- Rich Messages landed in Bot API 10.1 on 2026-06-11, so client compatibility should be checked with `/rich` and `/diff`.
- `sendRichMessageDraft` targets private users; group, topic, and multi-bot paths must keep existing rendering.
- Rich media blocks add bot permission and media URL/upload constraints; they are not a Phase 1 target.
- Automatic entity detection can mis-detect paths, emails, URLs, and commands; rich builders should choose `skip_entity_detection` per message type.
- All Codex, shell, and file output must pass through centralized escaping before entering HTML/rich markup.
