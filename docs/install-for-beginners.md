# Beginner Install Guide

This guide is for a first FoxClaw install. It assumes you can open a terminal and paste commands, but it does not assume you already know Node.js, Telegram bots, or Codex CLI.

FoxClaw runs on your own computer. Your phone talks to a Telegram bot, the bot talks to FoxClaw, and FoxClaw talks to local Codex. You do not need a public server.

If you already have a shell-capable agent such as Codex, OpenClaw, QwenPaw, Hermes, OpenCode, or Kimi CLI on this computer, use [Agent-Assisted Install](./agent-assisted-install.md) first. It is the recommended path.

Before you start:

- Do not configure a Telegram group first. Use private chat first.
- Do not send your bot token to anyone you do not trust.
- Do not use `/`, `/Users`, `/home`, or your whole home directory as `DEFAULT_CWD` for the first install.
- Use `foxclaw start` for normal startup. Use foreground mode only when troubleshooting.

## 1. Prepare

You need:

- a macOS or Linux computer that can stay on while you use FoxClaw
- a Telegram account
- a Codex account
- a folder where Codex can work, for example `~/Projects` or `~/Desktop`
- about 10-20 minutes for the first setup

Use private chat first. Group and topic setup can wait until the bot replies reliably.

## 2. Install Node.js 24+

FoxClaw needs Node.js 24+ because it uses the built-in SQLite runtime. It does not require nvm; you can use nvm, fnm, asdf, mise, Volta, Homebrew, or your system package manager.

If you already have Node 24+, this should print `v24...` or newer:

```bash
node -v
```

If not, nvm is a good default for first-time users. Example:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

If you use nvm and `node -v` still shows an old version, close the terminal, open a new one, and run:

```bash
nvm use 24
```

## 3. Install And Log In To Codex

FoxClaw does not create a Codex account. It uses the Codex CLI already logged in on this computer.

Install the Codex CLI if you do not already have it:

```bash
npm install -g @openai/codex
```

If this fails with `EACCES` or `permission denied`, stop and check [Troubleshooting](./troubleshooting.md). Do not keep retrying with random `sudo` commands.

Log in:

```bash
codex login
```

Check the CLI exists:

```bash
codex --version
```

`codex --version` only proves the command exists. To verify Codex auth actually works, start Codex and run one tiny request:

```bash
codex
```

Ask it:

```text
Say ready and exit.
```

If your Codex CLI supports `codex login status`, you can also use it, but the real test is that Codex can answer a normal prompt without asking you to log in again.

## 4. Create A Telegram Bot

1. Open Telegram.
2. Search for `@BotFather`.
3. Send `/newbot`.
4. Follow the prompts and choose a bot name.
5. Copy the bot token. It looks like `123456789:AA...`.

Keep this token private. Anyone with the token can control that Telegram bot.

## 5. Get Your Numeric Telegram User ID

FoxClaw only accepts messages from one configured Telegram user.

The easiest path:

1. Open Telegram.
2. Search for `@userinfobot`.
3. Send it any message or press Start.
4. Copy the numeric `Id`.

Use the number, not your `@username`.

## 6. Install FoxClaw

Install the published npm package:

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
```

This creates the config file at `~/.foxclaw/.env` and prompts for one or more comma-separated Telegram bot tokens, your numeric Telegram user id, and the default workspace. New installs use `TG_BOT_TOKENS`; legacy `TG_BOT_TOKEN` is only for existing single-bot configurations.

If you prefer pnpm:

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
```

## 7. Fill In `.env`

If you filled the token, user id, and workspace during `foxclaw init`, go straight to the first check. If you skipped a field or want to change anything, open `.env` in a simple editor:

```bash
nano ~/.foxclaw/.env
```

For a first private-chat install, fill only the important values:

```dotenv
TG_BOT_TOKENS=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/a/folder
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

Keep `TG_ALLOWED_CHAT_ID=` and `TG_ALLOWED_TOPIC_ID=` empty for the first install. Do not delete those lines; leaving them empty means private-chat mode.

Start with one bot. To add three independent Codex lanes later, put the tokens on the same line:

```dotenv
TG_BOT_TOKENS=123456789:token_a,234567890:token_b,345678901:token_c
```

FoxClaw still installs one service, but each bot receives its own app-server, session home, and current auth selection. After startup, privately send `/help` and `/status` to each bot.

`DEFAULT_CWD` must be a real folder. Examples:

```dotenv
DEFAULT_CWD=/Users/alice/Desktop
DEFAULT_CWD=/home/alice/projects
```

In `nano`, press `Ctrl+O`, Enter, then `Ctrl+X` to save and exit.

## 8. Run The First Check

Run doctor:

```bash
foxclaw doctor
```

You want to see:

```text
[OK] node >= 24
[OK] codex cli available
[OK] telegram bot token(s) configured
[OK] telegram allowed user configured
[OK] default cwd exists
```

If you see `[FAIL]`, stop and check [Troubleshooting](./troubleshooting.md).

## 9. Start FoxClaw

Start or restart the background service:

```bash
foxclaw start
```

This command is safe to run again. It runs the same checks as `doctor`, then installs or restarts the service for your platform.

Now open your Telegram bot and send:

```text
/help
```

If it replies, send:

```text
/status
```

Then try a normal request, for example:

```text
List the files in the current working directory.
```

Good first messages to try:

```text
/setup
```

```text
List files in DEFAULT_CWD.
```

```text
Create a short README-style summary of this folder.
```

```text
/interrupt
```

## 10. Service Commands

On Linux, `foxclaw start` manages a user-level systemd service. Check it with:

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

The service starts again when your user session starts. If you need it to start after reboot before you log in, run:

```bash
loginctl enable-linger "$USER"
```

On macOS, `foxclaw start` manages launchd and starts FoxClaw when you log in.

For foreground debugging, stop the service first and then run `foxclaw serve`.

## 11. Day-To-Day Commands

Check current status:

```bash
foxclaw status
```

Restart Linux service after changing `.env`:

```bash
foxclaw restart
```

Stop the service:

```bash
foxclaw stop
```

Uninstall Linux service:

```bash
foxclaw uninstall-systemd
```

Update FoxClaw later:

```bash
foxclaw update
```

You can also send `/update` in an authorized Telegram chat. When every Telegram bot runtime, an enabled Weixin default runtime, and auth mirror writes are idle, it attempts to update an npm/pnpm-managed Codex CLI, upgrades FoxClaw, checks, restarts the service, and reports the result through the bot that started it.

## Next Step

After the first install works, read the [User Manual](./user-manual.md) for `/help`, `/setup`, `/threads`, `/watch`, `/auth`, Codex login, and multi-account auth rotation.
