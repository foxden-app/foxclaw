# Beginner Install Guide

This guide is for a first FoxClaw install. It assumes you can open a terminal and paste commands, but it does not assume you already know Node.js, Telegram bots, or Codex CLI.

FoxClaw runs on your own computer. Your phone talks to a Telegram bot, the bot talks to FoxClaw, and FoxClaw talks to local Codex. You do not need a public server.

## 1. Prepare

You need:

- a macOS or Linux computer that can stay on while you use FoxClaw
- a Telegram account
- a Codex account
- a folder where Codex can work, for example `~/Projects` or `~/Desktop`
- about 10-20 minutes for the first setup

Use private chat first. Group and topic setup can wait until the bot replies reliably.

## 2. Install Node.js 24

FoxClaw needs Node.js 24 because it uses the built-in SQLite runtime.

If you already have Node 24, this should print `v24...`:

```bash
node -v
```

If not, install Node 24 with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

If `node -v` still shows an old version, close the terminal, open a new one, and run:

```bash
nvm use 24
```

## 3. Install And Log In To Codex

FoxClaw does not create a Codex account. It uses the Codex CLI already logged in on this computer.

Install the Codex CLI if you do not already have it:

```bash
npm install -g @openai/codex
```

Log in and confirm the CLI works:

```bash
codex login
codex login status
```

The important check is that this command exists and reports a logged-in account:

```bash
codex --version
```

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

## 6. Download FoxClaw

Choose a stable folder and clone the repo:

```bash
git clone https://github.com/foxden-app/foxclaw.git
cd foxclaw
npm install
cp .env.example .env
```

## 7. Fill In `.env`

Open `.env` in a simple editor:

```bash
nano .env
```

For a first private-chat install, fill only the important values:

```dotenv
TG_BOT_TOKEN=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/a/folder
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

`DEFAULT_CWD` must be a real folder. Examples:

```dotenv
DEFAULT_CWD=/Users/alice/Desktop
DEFAULT_CWD=/home/alice/projects
```

In `nano`, press `Ctrl+O`, Enter, then `Ctrl+X` to save and exit.

## 8. Run The First Check

Build and run doctor:

```bash
npm run build
npm run doctor
```

You want to see:

```text
[OK] node >= 24
[OK] codex cli available
[OK] telegram bot token configured
[OK] telegram allowed user configured
[OK] default cwd exists
```

If you see `[FAIL]`, stop and check [Troubleshooting](./troubleshooting.md).

## 9. Start In The Foreground First

Run FoxClaw directly before installing it as a background service:

```bash
npm run serve
```

Leave this terminal open.

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

Stop the foreground process with `Ctrl+C` after the bot works.

## 10. Install As A Background Service

Only do this after foreground mode works.

On Linux with systemd:

```bash
npm run install-systemd
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

The service starts again when your user session starts. If you need it to start after reboot before you log in, run:

```bash
loginctl enable-linger "$USER"
```

On macOS:

```bash
./scripts/launchd/install.sh
```

launchd starts FoxClaw when you log in.

## 11. Day-To-Day Commands

Check current status:

```bash
npm run status
```

Restart Linux service after changing `.env`:

```bash
systemctl --user restart foxclaw.service
```

Stop Linux service:

```bash
systemctl --user stop foxclaw.service
```

Uninstall Linux service:

```bash
npm run uninstall-systemd
```

Update FoxClaw later:

```bash
git pull
npm install
npm run build
systemctl --user restart foxclaw.service
```
