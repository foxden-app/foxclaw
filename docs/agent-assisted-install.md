# Agent-Assisted Install

If you already have a shell-capable coding agent on the target computer, use this path first. It is the fastest and least error-prone way to install FoxClaw.

This works well with Codex, OpenClaw, QwenPaw, Hermes, OpenCode, Kimi CLI, or any agent that can inspect the machine, run shell commands, edit files, and report blockers.

## What You Need To Provide

Prepare these values before asking the agent:

- `TG_BOT_TOKEN`: Telegram bot token from `@BotFather`
- `TG_ALLOWED_USER_ID`: your numeric Telegram user id
- `DEFAULT_CWD`: the folder where Codex should work

Optional later:

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

Use private Telegram chat first. Configure groups/topics only after private chat works.

## Copy-Paste Prompt

Send this to your agent on the target computer:

```text
Install FoxClaw on this machine.

Repository:
https://github.com/foxden-app/foxclaw.git

Use private Telegram chat first. Do not configure group/topic mode unless I explicitly provide TG_ALLOWED_CHAT_ID or TG_ALLOWED_TOPIC_ID.

Here are the required values:
TG_BOT_TOKEN=<paste token here>
TG_ALLOWED_USER_ID=<paste numeric Telegram user id here>
DEFAULT_CWD=<paste absolute working directory here>

Tasks:
1. Inspect the machine first. Do not overwrite local changes if a FoxClaw or old telegram-codex-app-bridge repo already exists.
2. Ensure Node.js 24+ is available. If not, install or activate Node 24 with nvm.
3. Ensure the Codex CLI exists and is logged in. If login is required, stop and tell me exactly what I need to do.
4. Clone or update https://github.com/foxden-app/foxclaw.git.
5. Write a local .env. Never commit .env.
6. Run npm install, npm run build, and npm run doctor.
7. Start FoxClaw in the foreground first and ask me to send /help and /status to the Telegram bot.
8. Only after the foreground test works, install the background service:
   - Linux: npm run install-systemd
   - macOS: ./scripts/launchd/install.sh
9. Verify the final state:
   - foxclaw.service is active/enabled on Linux
   - old telegram-codex-app-bridge.service is inactive/disabled if present
   - npm run status works
10. Report the commands used, the final status, and the log command I should use if something stops working.
```

## Migration Prompt For Old Installs

Use this when the target computer is still running `telegram-codex-app-bridge`:

```text
Migrate this machine from telegram-codex-app-bridge to FoxClaw.

New repository:
https://github.com/foxden-app/foxclaw.git

Please:
1. Check git status before changing the repo. If there are uncommitted local changes, stop and report them.
2. Stop and disable telegram-codex-app-bridge.service if it exists.
3. If ~/.foxclaw does not exist and ~/.telegram-codex-app-bridge exists, copy ~/.telegram-codex-app-bridge to ~/.foxclaw.
4. Update the source repo to https://github.com/foxden-app/foxclaw.git and pull main.
5. Run npm install, npm run build, npm run doctor.
6. Install and start foxclaw.service with npm run install-systemd.
7. Verify foxclaw.service is active and telegram-codex-app-bridge.service is inactive/disabled.
8. Report final status and any blockers.
```

## Safety Notes

- Do not paste bot tokens into public issue trackers or public chat logs.
- Do not commit `.env`.
- Do not use `/` or your whole home directory as `DEFAULT_CWD` for a first install.
- Do not install the background service before the foreground Telegram test works.
