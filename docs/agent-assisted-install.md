# Agent-Assisted Install

If you already have a shell-capable coding agent on the target computer, use this path first. It is the fastest and least error-prone way to install FoxClaw.

This works well with Codex, OpenClaw, QwenPaw, Hermes, OpenCode, Kimi CLI, or any agent that can inspect the machine, run shell commands, edit files, and report blockers.

## What You Need To Provide

Prepare these values before asking the agent:

- `TG_BOT_TOKENS`: one or more comma-separated Telegram bot tokens from `@BotFather`
- `TG_ALLOWED_USER_ID`: your numeric Telegram user id
- `DEFAULT_CWD`: the folder where Codex should work

Optional later:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

Use private Telegram chat first. Configure groups/topics only after private chat works. Multiple tokens mean independent Codex runtimes inside one service; validate each bot privately.

## Copy-Paste Prompt

Send this to your agent on the target computer:

```text
Install FoxClaw on this machine.

Repository:
Published package:
@foxden-app/foxclaw

Use private Telegram chat first. Do not configure group/topic mode unless I explicitly provide TG_ALLOWED_CHAT_ID or TG_ALLOWED_TOPIC_ID.

Here are the required values:
TG_BOT_TOKENS=<paste one token, or comma-separated tokens here>
TG_ALLOWED_USER_ID=<paste numeric Telegram user id here>
DEFAULT_CWD=<paste absolute working directory here>

Tasks:
1. Inspect the machine first. If a FoxClaw service already exists, report it before changing services.
2. Ensure Node.js 24+ is available. If not, install or activate Node 24+ by any suitable method; nvm is only one common option.
3. Ensure the Codex CLI exists and is logged in. If login is required, stop and tell me exactly what I need to do.
4. Install or update FoxClaw with npm install -g @foxden-app/foxclaw@latest.
5. Run foxclaw init, then write ~/.foxclaw/.env. Never print or commit the bot token.
6. Run foxclaw doctor.
7. Start FoxClaw with foxclaw start.
8. Ask me to send /help, /status, and /auth privately to each configured Telegram bot; confirm /auth names that bot runtime.
9. Verify the final state:
   - foxclaw.service is active/enabled on Linux
   - foxclaw status works
10. Report the commands used, the final status, and the log command I should use if something stops working. Redact TG_BOT_TOKENS and never print the full token or full .env content.
11. If multiple bots are enabled, confirm foxclaw status lists independent app-servers; group-chat tests must mention or reply to the intended bot.
```

## Safety Notes

- Do not paste bot tokens into public issue trackers or public chat logs.
- Do not commit `.env`.
- When reporting results, redact `TG_BOT_TOKENS` and legacy `TG_BOT_TOKEN`.
- Do not use `/` or your whole home directory as `DEFAULT_CWD` for a first install.
- Use `foxclaw start` for normal service startup. Use foreground `foxclaw serve` only when troubleshooting.
