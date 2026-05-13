[中文](./README.md) ｜ English

# FoxClaw

FoxClaw is the local execution claw for Foxden agents.

It runs on your own computer and lets a trusted Telegram or Weixin chat control your local Codex environment. You do not need a public server: FoxClaw talks to Codex over local `codex app-server`, keeps approvals on your machine, and sends the working conversation back to your phone.

## Start Here

- Already have a shell-capable agent such as Codex, OpenClaw, QwenPaw, Hermes, OpenCode, or Kimi CLI? Use the [Agent-Assisted Install](./docs/agent-assisted-install.md) first. This is the recommended path.
- New to Node, Telegram bots, or Codex CLI? Use the [Beginner Install Guide](./docs/install-for-beginners.md).
- Already comfortable with Git, Node, and `.env` files? Use the quick setup below.
- Something failed? Check [Troubleshooting](./docs/troubleshooting.md).

FoxClaw is a good fit if you want to:

- use Codex from your phone without exposing your computer to the public internet
- keep code, shell access, auth, approvals, and runtime data on your own machine
- use one trusted Telegram user as the remote operator

The minimum install needs only a Telegram bot token, your numeric Telegram user id, Node.js 24, and a logged-in `codex` CLI. A first install usually takes 10-20 minutes.

30-second product example: after FoxClaw is running, send `List files in DEFAULT_CWD` to your Telegram bot. FoxClaw asks local Codex to inspect that folder on your computer and sends the answer back to Telegram.

## Requirements

- macOS or Linux with a working `codex` CLI
- Codex authenticated on the host machine
- Node.js 24+
- A Telegram bot token from `@BotFather`
- Your Telegram numeric user id

## npm Quick Setup

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
$EDITOR ~/.foxclaw/.env
foxclaw doctor
foxclaw start
```

pnpm users can use:

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
$EDITOR ~/.foxclaw/.env
foxclaw doctor
foxclaw start
```

Edit `.env` before running `doctor` or `start`. Minimum private-chat config:

```dotenv
TG_BOT_TOKEN=123456:telegram-token
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

The default config file is `~/.foxclaw/.env`. Set `FOXCLAW_ENV=/path/to/.env` if you want to keep it somewhere else.

`foxclaw start` runs checks and installs or restarts the background service. It is idempotent, so run it again after upgrading.

FoxClaw accepts messages only from `TG_ALLOWED_USER_ID`. Putting the bot in a group does not make it available to every group member.

<details>
<summary>What FoxClaw can do after it is running</summary>

- Telegram private chat, group, and topic control for one allowed Telegram user
- Optional Weixin/iLink channel for the same bridge core
- Sticky chat-to-thread binding with `/threads`, `/open`, `/new`, `/where`, and `/interrupt`
- Thread lifecycle controls from mobile: rename, archive, unarchive, fork, rollback, compact, review, and diff
- Chat-scoped setup panel for model, reasoning effort, Fast service tier, access preset, Agent/Plan mode, and active-turn behavior
- Codex account controls with `/account`, `/quota`, `/login_device`, `/login_cancel`, `/auth add <name>`, and guarded `/logout confirm`
- Automatic local Codex auth rotation across `auth.json_*` candidates when a usage-limit auth fails
- Inline approval buttons for command, file-change, and granular permission approvals
- MCP elicitation cards for structured questions raised by tools during a turn
- Skills, MCP, hooks, plugins, apps, feature flags, config, requirements, and provider diagnostics
- SQLite persistence for bindings, offsets, approvals, pending input prompts, and audit logs
- Single-instance process lock to prevent duplicate Telegram polling on the same bot token

</details>

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

For foreground debugging:

```bash
foxclaw serve
```

Default runtime files are stored under `~/.foxclaw`:

- store: `~/.foxclaw/data/bridge.sqlite`
- bridge log: `~/.foxclaw/logs/service.log`
- status: `~/.foxclaw/runtime/status.json`
- app-server state: `~/.foxclaw/runtime/codex-app-server.json`
- app-server log: `~/.foxclaw/logs/codex-app-server.log`

Override the store, lock, and app-server paths with `STORE_PATH`, `LOCK_PATH`, `CODEX_APP_SERVER_STATE_PATH`, and `CODEX_APP_SERVER_LOG_PATH`.

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

To discover group and topic ids:

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
- `/setup` opens the unified preference panel
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
- `/models`, `/model`, `/effort`, `/permissions`, `/access`, `/mode`, `/plan`, and `/agent`
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

This repo ships a Codex skill at [`skills/foxclaw`](./skills/foxclaw). Use it when you want Codex to bootstrap FoxClaw locally or on another Mac over SSH, write `.env`, build, run doctor, install launchd, and guide first-message validation.

## Troubleshooting

See [Troubleshooting](./docs/troubleshooting.md) for `doctor` failures, Telegram no-reply cases, service logs, reboot behavior, and migration issues.

## Operations

```bash
foxclaw doctor
foxclaw status
foxclaw start
foxclaw uninstall-systemd
```

## Contributing

Issues and PRs are welcome at `https://github.com/foxden-app/foxclaw`.
