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

If FoxClaw is installed as a macOS launchd service, check:

```bash
launchctl print "gui/$(id -u)/app.foxden.foxclaw"
tail -f ~/.foxclaw/logs/launchd.err.log ~/.foxclaw/logs/service.log
```

## Doctor Failures

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `[FAIL] node >= 24` | Your current shell is using an older Node.js. | Install or activate Node.js 24+ by any method, then rerun `foxclaw doctor`. If the service uses old Node, reinstall it from a Node 24+ shell with `foxclaw start`. |
| `[FAIL] codex cli available` | The `codex` command is not in PATH. | Install Codex CLI or fix PATH, then confirm `codex --version` works. |
| `[FAIL] telegram bot token(s) configured` | Neither `TG_BOT_TOKENS` nor legacy `TG_BOT_TOKEN` is present in `.env`. | Put one or more comma-separated `@BotFather` tokens in `TG_BOT_TOKENS`. |
| `[FAIL] telegram allowed user configured` | `TG_ALLOWED_USER_ID` is missing from `.env`. | Get your numeric id from `@userinfobot` and add it to `.env`. |
| `[FAIL] default cwd exists` | `DEFAULT_CWD` points to a folder that does not exist. | Create the folder or change `DEFAULT_CWD` to an existing absolute path. |

## Node Or npm Is Missing

If you see `node: command not found` or `npm: command not found`, install Node.js 24+ using your preferred tool, such as nvm, fnm, asdf, mise, Volta, Homebrew, or your system package manager. This is an nvm example:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
npm -v
```

If you use nvm and it still fails, close the terminal, open a new one, and run:

```bash
nvm use 24
```

## npm Permission Errors

If `npm install -g @openai/codex` fails with `EACCES`, `EPERM`, or `permission denied`, your global npm directory is not writable by your user.

Recommended fix: use a user-level Node.js 24+ install, then install again. This is an nvm example:

```bash
nvm install 24
nvm use 24
npm install -g @openai/codex
```

Avoid `sudo npm install -g ...` unless you already understand how your Node installation is managed. Mixing `sudo`, system Node, and user-level Node managers is a common source of broken PATHs.

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

Check the service and any extra foreground processes:

```bash
systemctl --user is-active foxclaw.service
pgrep -af foxclaw
```

On macOS, use:

```bash
launchctl print "gui/$(id -u)/app.foxden.foxclaw"
pgrep -af foxclaw
```

Stop the extra process or service, then restart FoxClaw:

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

If FoxClaw's `/login_device`, `/auth add <name>`, or `/auth` panel Login button gives you a device code but the login page says it is not allowed, falls back to the regular browser flow, or cannot complete on a headless host, check ChatGPT security settings first: open `https://chatgpt.com/`, click your username in the lower-left corner, go to Settings > Security, and enable device code authorization for Codex. Workspace accounts may require an admin to allow device-code login. Treat the device code as a login grant and never share it.

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

## Checking Multi-Bot Mode

After configuring `TG_BOT_TOKENS`, `foxclaw status` should contain one bot id, connection status, and runtime type for each token. Send `/status` privately to any bot to see the runtime summary; send `/auth` to confirm the panel names the current `@botname` and its auth directory. If `TG_BOT_TOKEN` exactly matches one token in `TG_BOT_TOKENS`, that bot should appear as the default/shared-terminal runtime; the others should appear as isolated.

Each isolated app-server log is stored at:

```bash
tail -f ~/.foxclaw/logs/codex-app-server-bot<id>.log
```

When multiple bots share a group, unaddressed messages intentionally do not trigger them; mention `@botname`, reply to the intended bot, or send `/status@botname`. When enabled, Weixin stays on the default Codex runtime and does not appear inside an isolated Telegram bot's thread list.

## ChatGPT Backend 403 Or Unable To Load Site

If Telegram shows `ChatGPT backend 403 Forbidden`, or the app-server log contains `Unable to load site`, `cf-ray`, or `chatgpt.com/backend-api`, the auth file is not necessarily broken. The service process is usually reaching ChatGPT with the wrong network/proxy/IP.

A common cause is that your shell or project `.env` has proxy variables, while the systemd/launchd service reads a different env file. On Linux, check the env file installed into the service:

```bash
systemctl --user cat foxclaw.service
```

On macOS, inspect `FOXCLAW_ENV` in the launchd plist:

```bash
plutil -p ~/Library/LaunchAgents/app.foxden.foxclaw.plist | grep FOXCLAW_ENV -A1
```

`foxclaw init` detects proxy environment variables in the current shell and asks whether to save them into the FoxClaw `.env`. If you skipped that step, `foxclaw doctor` warns when it sees proxy variables in the shell but not in the FoxClaw env file.

Make sure the file referenced by `Environment=FOXCLAW_ENV=...` contains your proxy variables, for example:

```dotenv
HTTP_PROXY=http://127.0.0.1:20171
HTTPS_PROXY=http://127.0.0.1:20171
ALL_PROXY=socks5://127.0.0.1:20170
NO_PROXY=127.0.0.1,localhost
```

When `HTTP_PROXY` or `HTTPS_PROXY` is configured, FoxClaw passes those variables to systemd/launchd explicitly and starts Node with `--use-env-proxy`. Do not rely on proxy variables from the current shell; service processes do not inherit them automatically.

Restart FoxClaw after editing. The restart also restarts the managed Codex app-server so the new proxy environment takes effect:

```bash
foxclaw restart
```

If a Linux host must use `proxychains4` to reach Telegram or ChatGPT, do not hand-write a systemd drop-in that overrides `ExecStart`. Add this to the FoxClaw env file instead:

```dotenv
FOXCLAW_PROXYCHAINS_CONF=/home/wuya/.proxychains-rt.conf
```

Then run:

```bash
foxclaw restart
```

FoxClaw writes proxychains into the main service and removes stale FoxClaw `ExecStart` overrides, so later upgrades only need `foxclaw update`.

## Service Starts With The Wrong Node Version

The systemd installer records the absolute path of the Node process that is currently running FoxClaw. It does not rely on systemd loading `nvm.sh` or any other shell init script. Whether you use nvm, fnm, asdf, mise, Volta, Homebrew, or system Node, run `foxclaw start` from a Node 24+ shell and the service will keep using that Node 24+ path.

macOS launchd follows the same rule: the plist records the absolute Node path that ran `foxclaw start` and does not rely on login-shell initialization.

If you installed the service from a shell using Node 22 or older, reinstall it from a Node 24+ shell. Example for nvm users:

```bash
nvm use 24
foxclaw start
systemctl --user status foxclaw.service
```

On macOS:

```bash
nvm use 24
foxclaw start
launchctl print "gui/$(id -u)/app.foxden.foxclaw"
```

The status output should show a Node 24+ path. `foxclaw doctor` also checks the installed systemd/launchd service Node path and warns if it is missing or older than 24.

## Does It Run After Reboot?

Linux user systemd:

```bash
systemctl --user is-enabled foxclaw.service
```

`enabled` means it starts with your user session. `foxclaw start` tries to enable systemd user linger automatically so the service keeps running after SSH logout and before login. If automatic linger setup fails:

```bash
sudo loginctl enable-linger "$USER"
```

macOS launchd starts FoxClaw when you log in after running:

```bash
foxclaw start
```
