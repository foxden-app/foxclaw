[中文](./README.md) ｜ English

# 🦊 FoxClaw

**A mobile Codex controller built for real programming workflows.**

FoxClaw turns your phone into a practical web coding cockpit for your local Codex. Telegram or Weixin handles the chat interface, `codex app-server` handles local execution, and you can send tasks, inspect progress, approve actions, switch threads, and keep working without opening a laptop.

It is built for the moments when you leave your desk for lunch, commute, travel, use a treadmill, or take the kids to the park. You can step away from the keyboard while Codex keeps coding and sends progress, errors, approval requests, and final results back to your phone.

No public server required. FoxClaw runs on your own computer, talks to `codex app-server` locally, and keeps code, shell access, auth, approvals, and runtime data on that machine.

## Why FoxClaw

**Why Codex as the underlying engine?**

1. **Open source with complete APIs** — Codex is OpenAI's open-source CLI agent and ships `codex app-server`. FoxClaw does not scrape a terminal; it uses the app-server interface to read threads, switch models, handle approvals, and resume sessions.
2. **Strong current coding experience** — FoxClaw reads the model list from your local Codex app-server. If your Codex environment has GPT-5.5 available, you can select and use it from your phone. For many heavy coding workflows, Codex/GPT-5.5 is already the reason to choose this stack.
3. **Multi-account quota rotation** — Free quota, trial Plus/Team accounts, and small account-specific allowances can all live as local `auth.json_*` candidates. When one account hits a 5-hour usage limit, FoxClaw switches to the next available account, restarts app-server, and retries the failed request.

**Built for these scenarios:**

- 🍜 Leave your desk for lunch — Codex keeps coding, tap to approve when needed
- 🚶 Commute or travel — dispatch tasks, inspect progress, and continue debugging without a laptop
- 🏃 Use a treadmill or spend time at the park — monitor Codex's coding process from your phone
- 🔒 Code, shell, auth, approvals, and runtime data stay on your machine — nothing exposed to the public internet
- 👤 Only one trusted Telegram user can operate the bot

## Start Here

- Already have a shell-capable agent such as Codex, OpenClaw, QwenPaw, Hermes, OpenCode, or Kimi CLI? Use the [Agent-Assisted Install](./docs/agent-assisted-install.md) first. This is the recommended path.
- New to Node, Telegram bots, or Codex CLI? Use the [Beginner Install Guide](./docs/install-for-beginners.md).
- Already installed and want the full command guide for `/help`, `/setup`, `/threads`, `/watch`, `/auth`, and auth rotation? Read the [User Manual](./docs/user-manual.md).
- Already comfortable with Git, Node, and `.env` files? Use the quick setup below.
- Something failed? Check [Troubleshooting](./docs/troubleshooting.md).

The minimum install needs only a Telegram bot token, your numeric Telegram user id, Node.js 24, and a logged-in `codex` CLI. A first install usually takes 10–20 minutes.

**30-second demo**: after FoxClaw is running, send `List files in DEFAULT_CWD` to your Telegram bot. FoxClaw asks local Codex to inspect that folder on your computer and sends the answer back to Telegram.

## Requirements

- macOS or Linux with a working `codex` CLI
- Codex authenticated on the host machine
- Node.js 24+
- A Telegram bot token from `@BotFather`
- Your Telegram numeric user id

## Quick Setup

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
foxclaw doctor
foxclaw start
```

pnpm users:

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
foxclaw doctor
foxclaw start
```

`foxclaw init` creates `~/.foxclaw/.env` and prompts for the Telegram bot token, your numeric Telegram user id, and the default workspace. Press Enter on any field to skip it and edit later with `$EDITOR ~/.foxclaw/.env`.

Fill `.env` before running `doctor` or `start`. Minimum private-chat config:

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

The default config file is `~/.foxclaw/.env`. Set `FOXCLAW_ENV=/path/to/.env` if you want to keep it somewhere else.

`foxclaw start` runs checks and installs or restarts the background service. It is idempotent — run it again after upgrading.

FoxClaw accepts messages only from `TG_ALLOWED_USER_ID`. Putting the bot in a group does not make it available to every group member.

<details>
<summary>What FoxClaw can do after it is running</summary>

**Core capabilities:**
- Telegram private chat, group, and topic control for your local Codex
- Optional Weixin/iLink channel sharing the same bridge core
- Full thread lifecycle management from mobile: create, rename, archive, fork, rollback, compact, review, diff
- Inline approval buttons for commands, file changes, and granular permissions — one tap to approve
- MCP elicitation cards for structured questions raised by tools during a turn

**Multi-account management:**
- Codex account controls: `/account`, `/quota`, `/login_device`, `/auth add <name>`
- Automatic auth rotation across local `auth.json_*` files when a usage limit is hit — seamless account switching
- `/auth` panel to view, enable, disable, and switch between candidate accounts

**Threads and sessions:**
- `/threads`, `/open`, `/new`, `/where`, `/interrupt` — sticky chat-to-thread binding
- Chat-scoped setup panel for model, reasoning effort, Fast tier, access preset, Agent/Plan mode
- Skills, MCP, hooks, plugins, apps, feature flags, config, requirements, and provider diagnostics

**Reliability:**
- SQLite persistence for bindings, offsets, approvals, pending input prompts, and audit logs
- Single-instance process lock to prevent duplicate Telegram polling on the same bot token

</details>

## Multi-Account Rotation

A key FoxClaw feature is automatic multi-account switching. When one account's 5-hour usage limit is triggered, FoxClaw automatically switches to the next available account and continues working.

Setup:

1. Place multiple auth files in the Codex auth directory (usually `~/.codex/`), named like `auth.json_personal`, `auth.json_team`, etc.
2. Use `/auth add <name>` to add new accounts directly from Telegram.
3. Use `/auth` to view all candidate account statuses.
4. Use `/auth enable <n>` / `/auth disable <n>` to control which accounts participate in auto-rotation.

When Codex reports a usage-limit error, FoxClaw automatically:
- Switches to the next non-failed candidate account
- Restarts app-server to load the new auth
- Retries the failed request with the new account

## Service And Debugging

Recommended:

```bash
foxclaw start
```

It installs or restarts the Linux user systemd service, or loads/reloads launchd on macOS. To inspect Linux service state:

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

You can also use the wrapper commands:

```bash
foxclaw status
foxclaw restart
foxclaw stop
```

For foreground debugging:

```bash
foxclaw serve
```

Default runtime files are stored under `~/.foxclaw`:

| Purpose | Path |
|---------|------|
| Database | `~/.foxclaw/data/bridge.sqlite` |
| Bridge log | `~/.foxclaw/logs/service.log` |
| Status | `~/.foxclaw/runtime/status.json` |
| App-server state | `~/.foxclaw/runtime/codex-app-server.json` |
| App-server log | `~/.foxclaw/logs/codex-app-server.log` |

Override with `STORE_PATH`, `LOCK_PATH`, `CODEX_APP_SERVER_STATE_PATH`, and `CODEX_APP_SERVER_LOG_PATH`.

## Migrating From telegram-codex-app-bridge

FoxClaw was originally forked from `Gan-Xing/telegram-codex-app-bridge` and remains distributed under the MIT License.

When upgrading an existing local install:

```bash
systemctl --user disable --now telegram-codex-app-bridge.service 2>/dev/null || true
test -e ~/.foxclaw || cp -a ~/.telegram-codex-app-bridge ~/.foxclaw
foxclaw start
```

For launchd installs, unload the old plist if present:

```bash
launchctl unload ~/Library/LaunchAgents/com.ganxing.telegram-codex-app-bridge.plist 2>/dev/null || true
foxclaw start
```

The old runtime directory is not read automatically. Copy it once if you want to keep existing bindings, cached thread lists, approvals, and status data.

## Telegram Setup

1. Create a bot with `@BotFather` and copy the token into `TG_BOT_TOKEN`.
2. Get your Telegram numeric user id and place it into `TG_ALLOWED_USER_ID`.
3. Start FoxClaw with `foxclaw start`.
4. Open a private chat with the bot and send `/help`.

Optional group/topic config:

```dotenv
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
```

- Leave `TG_ALLOWED_CHAT_ID` empty for private-chat mode.
- Set `TG_ALLOWED_CHAT_ID` only to allow one group as the default conversation scope.
- Set both `TG_ALLOWED_CHAT_ID` and `TG_ALLOWED_TOPIC_ID` to bind one topic as the default scope.
- Private chat remains available for `TG_ALLOWED_USER_ID` even when a group is configured.

**How to find group and topic IDs:**

1. Stop FoxClaw.
2. Send a message in the target group or topic.
3. Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
4. Read `message.chat.id` as `TG_ALLOWED_CHAT_ID`.
5. Read `message.message_thread_id` as `TG_ALLOWED_TOPIC_ID`.

If FoxClaw is still running, it may consume the update before you inspect it.

## Telegram Group Checklist

For natural-language messages in a group or supergroup:

1. Add the bot to the target group.
2. Disable the bot's `privacy mode` in `@BotFather`.
3. Promote the bot to administrator in that group.
4. If privacy mode was changed after adding the bot, remove and re-add the bot.

Explicit commands such as `/status@botname` can work even when privacy mode blocks normal messages, so use a plain message to verify group setup.

## Codex App-Server Lifecycle

By default:

```dotenv
CODEX_APP_AUTOLAUNCH=true
CODEX_APP_LAUNCH_CMD=codex app
CODEX_APP_SERVER_STATE_PATH=
CODEX_APP_SERVER_LOG_PATH=
CODEX_APP_SYNC_ON_OPEN=true
CODEX_APP_SYNC_ON_TURN_COMPLETE=false
```

FoxClaw starts `codex app-server` as a detached, bridge-managed process and records its pid and port. On restart, it reconnects to the recorded app-server if that process is still alive; otherwise it starts a new one. `/auth_reload` and auth switching restart the managed app-server so the current `auth.json` is reloaded.

No static Codex app-server port is required in normal installs.

## Commands

- `/help`
- `/setup` — unified preference panel
- `/fast <on|off|toggle>`
- `/active <steer|queue>`
- `/status`, `/account`, `/quota`
- `/quota_nudge <credits|usage_limit> confirm`
- `/login_device`, `/login_cancel [id]`, `/logout confirm`
- `/auth [list|use <n>|enable <n>|disable <n>|reload|add <name>]`
- `/threads [query]`, `/threads archived`, `/open <n>`
- `/goal [objective|pause|resume|done|budget <tokens|off>|clear confirm]`
- `/history [limit]`, `/files <query>`, `/remote`
- `/new [cwd]`
- `/steer <message>`, `/takeover <message>`, `/queue <message>`
- `/review [base <branch>|commit <sha>|custom <instructions>]`
- `/diff`, `/fork [name]`, `/undo [n]`, `/rollback [n]`
- `/rename <name>`, `/compact`, `/archive`, `/unarchive <n>`
- `/skills [query]`, `/skill <name>`, `/skill_enable <name>`, `/skill_disable <name>`
- `/loaded`, `/hooks`, `/plugins [query]`, `/apps [reload]`, `/features`, `/config`, `/requirements`, `/provider`
- `/mcp`, `/mcp_reload`, `/mcp_login <server>`, `/mcp_resource <server> <uri>`
- `/models`, `/model`, `/effort`, `/permissions`, `/access`, `/mode`, `/plan`, `/agent`
- `/reveal`, `/where`, `/interrupt`

Plain text sends to the current thread, or creates a new one if none is bound.

## Weixin/iLink

Weixin support is optional and disabled by default:

```dotenv
WX_ENABLED=true
WX_ALLOWED_ILINK_USER_IDS=
```

Run the QR login helper once after building:

```bash
foxclaw weixin-login
```

Weixin runtime files default to `~/.foxclaw/weixin`.

## Codex Skill

This repo ships a Codex skill at [`skills/foxclaw`](./skills/foxclaw). Use it when you want Codex to bootstrap FoxClaw locally or on another Mac over SSH — write `.env`, build, run doctor, install launchd, and guide first-message validation.

## Troubleshooting

See [Troubleshooting](./docs/troubleshooting.md) for `doctor` failures, Telegram no-reply cases, service logs, reboot behavior, and migration issues.

## Operations

```bash
foxclaw doctor
foxclaw status
foxclaw start
foxclaw restart
foxclaw stop
foxclaw uninstall-systemd
```

## Contributing

Issues and PRs are welcome at [GitHub](https://github.com/foxden-app/foxclaw).
