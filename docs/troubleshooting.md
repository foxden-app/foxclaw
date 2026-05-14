# Troubleshooting

Start with these commands:

```bash
foxclaw doctor
foxclaw status
```

If FoxClaw is installed as a Linux user service, also check:

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

## Doctor Failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `[FAIL] node >= 24` | Your current shell is using an older Node.js. | Run `nvm install 24 && nvm use 24`, then rerun `foxclaw doctor`. If the service uses old Node, reinstall it from a Node 24 shell with `foxclaw start`. |
| `[FAIL] codex cli available` | The `codex` command is not in PATH. | Install Codex CLI or fix PATH, then confirm `codex --version` works. |
| `[FAIL] telegram bot token configured` | `TG_BOT_TOKEN` is missing from `.env`. | Copy the token from `@BotFather` into `.env`. |
| `[FAIL] telegram allowed user configured` | `TG_ALLOWED_USER_ID` is missing from `.env`. | Get your numeric id from `@userinfobot` and add it to `.env`. |
| `[FAIL] default cwd exists` | `DEFAULT_CWD` points to a folder that does not exist. | Create the folder or change `DEFAULT_CWD` to an existing absolute path. |

## Node Or npm Is Missing

If you see `node: command not found` or `npm: command not found`, install Node.js 24 with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

If it still fails, close the terminal, open a new one, and run:

```bash
nvm use 24
```

## npm Permission Errors

If `npm install -g @openai/codex` fails with `EACCES`, `EPERM`, or `permission denied`, your global npm directory is not writable by your user.

Recommended fix: use Node through `nvm`, then install again:

```bash
nvm install 24
nvm use 24
npm install -g @openai/codex
```

Avoid `sudo npm install -g ...` unless you already understand how your Node installation is managed. Mixing `sudo`, system Node, and `nvm` is a common source of broken PATHs.

If `codex` installs but FoxClaw still cannot find it, locate the binary:

```bash
command -v codex
```

Then put the absolute path in `.env`:

```dotenv
CODEX_CLI_BIN=/absolute/path/to/codex
```

## Bot Does Not Reply

Check these in order:

1. Make sure FoxClaw is running:

   ```bash
   foxclaw status
   ```

2. Try private chat first. Open your bot directly and send:

   ```text
   /help
   ```

3. Confirm `TG_ALLOWED_USER_ID` is your numeric Telegram id, not your `@username`.

4. Confirm the bot token in `.env` belongs to the bot you are messaging.

5. Restart after changing `.env`:

   ```bash
   foxclaw restart
   ```

   If running foreground mode, stop with `Ctrl+C` and run `foxclaw serve` again.

## Group Messages Do Not Work

Private chat is the easiest mode. For groups and topics:

1. Add the bot to the group.
2. Disable the bot's `privacy mode` in `@BotFather`.
3. Promote the bot to administrator.
4. Remove and re-add the bot if privacy mode was changed after it joined.
5. Configure `TG_ALLOWED_CHAT_ID`, and optionally `TG_ALLOWED_TOPIC_ID`.

Explicit commands such as `/status@botname` can work even when normal group messages are blocked by privacy mode, so verify with a plain natural-language message too.

## Get Group Or Topic IDs

1. Stop FoxClaw.
2. Send a new message in the target group or topic.
3. Open:

   ```text
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

4. Use `message.chat.id` as `TG_ALLOWED_CHAT_ID`.
5. Use `message.message_thread_id` as `TG_ALLOWED_TOPIC_ID`.

If FoxClaw is still running, it may consume the update before you inspect it.

## Telegram Polling Conflict

If Telegram reports conflicts or the same bot behaves strangely, two processes may be polling the same bot token.

Check old and new services:

```bash
systemctl --user is-active foxclaw.service
systemctl --user is-active telegram-codex-app-bridge.service 2>/dev/null || true
```

Stop the old service:

```bash
systemctl --user disable --now telegram-codex-app-bridge.service
```

Then restart FoxClaw:

```bash
foxclaw restart
```

## Codex Or App-Server Fails

FoxClaw requires local Codex auth. Check:

```bash
codex --version
```

If Codex is not logged in:

```bash
codex login
```

`codex --version` only verifies the command exists. To verify auth, run:

```bash
codex
```

Then ask:

```text
Say ready and exit.
```

If your CLI supports `codex login status`, that is also useful, but a normal successful prompt is the most reliable check.

FoxClaw app-server logs are stored here by default:

```bash
tail -f ~/.foxclaw/logs/codex-app-server.log
```

Bridge logs are stored here:

```bash
tail -f ~/.foxclaw/logs/service.log
```

## Service Starts With The Wrong Node Version

The systemd installer captures the `node` binary from your current PATH. If you installed the service from a shell using Node 22 or older, reinstall it from a Node 24 shell:

```bash
nvm use 24
foxclaw start
systemctl --user status foxclaw.service
```

The status output should show a Node 24 path in `ExecStart`.

## Does It Run After Reboot?

Linux user systemd:

```bash
systemctl --user is-enabled foxclaw.service
```

`enabled` means it starts with your user session. To start after reboot before login:

```bash
loginctl enable-linger "$USER"
```

macOS launchd starts FoxClaw when you log in after running:

```bash
foxclaw start
```

## Migrating From The Old Project Name

If this machine still runs `telegram-codex-app-bridge`, migrate once:

```bash
systemctl --user disable --now telegram-codex-app-bridge.service 2>/dev/null || true
test -e ~/.foxclaw || cp -a ~/.telegram-codex-app-bridge ~/.foxclaw
npm install -g @foxden-app/foxclaw@latest
foxclaw init
foxclaw doctor
foxclaw start
```

If `~/.foxclaw/.env` already exists, `foxclaw init` asks before updating the Telegram/workspace setup fields and leaves the rest untouched.
