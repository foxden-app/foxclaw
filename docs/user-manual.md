# FoxClaw User Manual

FoxClaw wraps your local Codex into a phone-controllable service. Telegram or Weixin provides the chat surface, FoxClaw handles auth, thread binding, approvals, setup panels, and account switching, and your local `codex app-server` performs the actual coding work.

Typical flow:

```text
Telegram/Weixin on your phone
  -> FoxClaw bot
  -> local FoxClaw service
  -> codex app-server
  -> DEFAULT_CWD or the current thread cwd
```

Your code, shell access, Codex auth, and runtime state stay on the host machine. For a first install, use Telegram private chat before configuring groups, topics, or Weixin.

## 1. Full Setup

### 1.1 Install Node.js 24+

FoxClaw requires Node.js 24+ and does not require nvm. Check first:

```bash
node -v
```

If this is not `v24...` or newer, install Node 24+ with nvm, fnm, asdf, mise, Volta, Homebrew, or your system package manager. This is an nvm example:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
node -v
```

### 1.2 Install And Log In To Codex

FoxClaw does not create a Codex account. It uses the Codex CLI already logged in on this machine.

```bash
npm install -g @openai/codex
codex login
codex --version
```

`codex --version` only proves the command exists. To verify auth, start Codex and run a tiny request:

```bash
codex
```

Then type:

```text
Say ready and exit.
```

If Codex answers normally, FoxClaw has a working execution backend.

### 1.3 Create A Telegram Bot

1. Open Telegram.
2. Search for `@BotFather`.
3. Send `/newbot`.
4. Follow the prompts to choose a bot name and username.
5. Copy the bot token. It looks like `123456789:AA...`.

Keep this token private. Anyone with the token can control the bot.

### 1.4 Get Your Numeric Telegram User ID

FoxClaw only responds to the user configured in `TG_ALLOWED_USER_ID`.

1. Open Telegram.
2. Search for `@userinfobot`.
3. Send any message or press Start.
4. Copy the numeric `Id`.

Use the number, not your `@username`.

### 1.5 Install FoxClaw

If you use pnpm for global packages:

```bash
pnpm add -g @foxden-app/foxclaw
foxclaw init
```

If you use npm:

```bash
npm install -g @foxden-app/foxclaw
foxclaw init
```

Both install the same published npm package. Use one global package manager consistently on a machine to avoid multiple versions in PATH.

### 1.6 Fill In The Config

`foxclaw init` creates the default config file at `~/.foxclaw/.env` and prompts for one or more comma-separated Telegram bot tokens, your numeric Telegram user id, and the default workspace. If the current shell has proxy variables such as `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`, it also asks whether to save them into the FoxClaw config. When `HTTP_PROXY` or `HTTPS_PROXY` is configured, FoxClaw passes it to systemd/launchd explicitly and enables Node's env proxy support. Press Enter on any field to skip it, then edit manually if needed:

```bash
$EDITOR ~/.foxclaw/.env
```

Minimum private-chat config:

```dotenv
TG_BOT_TOKENS=123456789:replace_with_your_bot_token
TG_ALLOWED_USER_ID=123456789
TG_ALLOWED_CHAT_ID=
TG_ALLOWED_TOPIC_ID=
DEFAULT_CWD=/absolute/path/to/workspace
DEFAULT_APPROVAL_POLICY=on-request
DEFAULT_SANDBOX_MODE=workspace-write
```

Fields:

- `TG_BOT_TOKENS`: one or more `@BotFather` tokens separated by commas. The legacy single-bot `TG_BOT_TOKEN` setting remains compatible.
- `TG_ALLOWED_USER_ID`: your numeric Telegram user id.
- `TG_ALLOWED_CHAT_ID`: leave empty for the first private-chat setup.
- `TG_ALLOWED_TOPIC_ID`: leave empty unless binding a Telegram topic.
- `DEFAULT_CWD`: the default directory where Codex works; it must exist.
- `DEFAULT_APPROVAL_POLICY`: `on-request` is a good first value.
- `DEFAULT_SANDBOX_MODE`: `workspace-write` is a good first value.

### 1.7 Check And Start

```bash
foxclaw doctor
foxclaw start
foxclaw status
```

For later upgrades, run `foxclaw update`. It uses the npm or pnpm installation method currently managing FoxClaw, attempts to update a globally npm/pnpm-managed Codex CLI, runs checks, and restarts the background service.

Linux service logs:

```bash
systemctl --user status foxclaw.service
journalctl --user -u foxclaw.service -f
```

On macOS, `foxclaw start` manages launchd. For foreground debugging, stop the background service and run:

```bash
foxclaw stop
foxclaw serve
```

### 1.8 First Telegram Test

Open a private chat with your bot and send:

```text
/help
```

```text
/status
```

```text
/setup
```

Then send a normal request:

```text
List files in DEFAULT_CWD.
```

If Codex replies, the basic path is working.

## 2. Groups And Topics

Private chat is the safest first mode. Configure a group or topic only after private chat works.

```dotenv
TG_ALLOWED_CHAT_ID=-1001234567890
TG_ALLOWED_TOPIC_ID=42
```

- Leave `TG_ALLOWED_CHAT_ID` empty for private chat only.
- Set only `TG_ALLOWED_CHAT_ID` to allow one group as the default conversation scope.
- Set both values to bind one topic.
- Private chat still works for `TG_ALLOWED_USER_ID` when a group is configured.

Find group or topic IDs:

1. Stop FoxClaw.
2. Send a message in the target group or topic.
3. Open:

   ```text
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

4. Use `message.chat.id` as `TG_ALLOWED_CHAT_ID`.
5. Use `message.message_thread_id` as `TG_ALLOWED_TOPIC_ID`.

If FoxClaw is still running, it may consume the update before you inspect it.

For group messages:

- Add the bot to the group.
- Disable privacy mode in `@BotFather`.
- Promote the bot to administrator.
- Test with a plain natural-language message, not only `/status@botname`.

## 3. Commands

### 3.1 `/help`

`/help` returns the available command list. The top entries are pinned:

```text
/help
/setup
/status
/threads [query]
/auth
```

Later commands are sorted by recent usage. Plain text, photos, and files continue the currently bound thread; if no thread is bound, FoxClaw creates one.

### 3.2 `/status`, `/account`, `/quota`, `/update`

- `/status`: FoxClaw, app-server, current thread binding, model, access, and Codex usage summary. In multi-bot mode it also lists every bot's connection, current auth, active turns, and the most recent auth mirror and service/Codex update outcomes. Local session, token, and visible-reply-throughput metrics use a background-generated historical snapshot instead of scanning large logs during the request; throughput is computed end-to-end for completed turns, excluding reasoning tokens while including waiting and tool execution time.
- `/account`: current Codex account.
- `/quota`: Codex usage and quota window.
- `/update`: upgrade FoxClaw, attempt to update an npm/pnpm-managed Codex CLI, run checks, and restart the service; it refuses while any Telegram bot runtime, an enabled Weixin default runtime, or an auth mirror write is busy, then reports the result through the initiating bot after restart.

### 3.3 `/config`, `/requirements`, `/provider`

- `/config`: reads the Codex config summary for the bound thread cwd or `DEFAULT_CWD`, including `model`, `approval_policy`, `sandbox_mode`, and `service_tier`.
- `/requirements`: shows app-server constraints such as allowed approval, sandbox, and web search modes.
- `/provider`: shows the current Codex provider summary.

These are useful when the phone-side model, permission, or provider behavior does not match what you expected.

## 4. The `/setup` Panel

`/setup` is one of the main mobile panels. Settings are scoped to the chat, so private chat, group, and topic can use different settings.

It controls:

- Model: server default, or a model returned by app-server.
- Reasoning effort: for example `low`, `medium`, `high`, or `xhigh`, depending on model support.
- Fast tier: available when supported by the selected model.
- Access: `read-only`, `default`, or `full-access`.
- Mode: `Agent` or `Plan`.
- Active turn behavior: steer the current turn, or queue the message for the next turn.

Telegram renders the HTML and buttons. This text block approximates the real panel:

```text
Session preferences
Current: gpt-5.5 · high · fast=off · default · Agent · Steer current turn
Focus: Model

Model: gpt-5.5
Effort: high
Fast: off
Access: Default (on-request / workspace-write)
Mode: Agent
Active turn: Steer current turn

[Auto]           [gpt-5.5]
[low] [medium] [high]
[⚡ Fast on]     [Fast off]
[👁️ Read-only]  [🛡️ Default]  [🔓 Full access]
[Agent]          [📝 Plan]
[Steer current turn] [Queue next turn]
```

Command aliases:

- `/model <model|default>`: switch model.
- `/effort <effort|default>`: switch reasoning effort.
- `/permissions [read-only|default|full-access]`: switch access preset.
- `/mode [default|plan]`: switch Agent/Plan.
- `/active <steer|queue>`: control how new messages behave during an active turn.

## 5. Threads And Watch

FoxClaw chats are bound to Codex threads. Once you open a thread from your phone, normal messages continue that thread.

Common commands:

- `/threads [query]`: list recent threads, optionally filtered by keyword.
- `/threads archived [query]`: list archived threads.
- `/open <n>`: open item n from the latest `/threads` list and bind this chat.
- `/new [cwd]`: create a new thread in a cwd, or in the default cwd.
- `/where`: show the current thread, cwd, and settings.
- `/rename <name>`: rename the current thread.
- `/archive`: archive the current thread.
- `/interrupt`: interrupt the current running turn.

Threads panel approximation:

```text
Recent threads
Tap a button below to open or manage a thread.
Showing 1-5
Current: fix auth rotation
~/Projects/foxclaw | 3 minutes ago | idle

[🧵 1. fix auth rotation]
[✏️] [👀] [🗑️] [➕]

[🧵 2. polish README copy]
[✏️] [👀] [🗑️] [➕]

[➕ New]
[➡️ Next]
[🗄️ Archived]
```

### `/watch`

`/watch` observes a thread even if the task was started elsewhere. A common workflow is starting a long Codex CLI task at your desk, then watching it from your phone.

Usage:

- `/watch`: watch the currently bound thread.
- `/watch <n>`: watch item n from the latest `/threads` list.
- `/unwatch`: stop watching.

Watch mode mirrors live turn progress and approval requests. The watching chat is read-only for normal prompts during the observed turn. Send `/unwatch` before starting a new prompt from that chat, or wait for the turn to finish.

## 6. Codex Login And Auth Rotation

This is a key FoxClaw feature. Codex auth is usually stored at `~/.codex/auth.json`. FoxClaw stores multiple accounts as candidate files and switches which candidate the active `auth.json` points to. In `TG_BOT_TOKENS` mode, each bot has an isolated Codex home, app-server, and current candidate, so bots can run and switch accounts independently; isolated Telegram runtimes force file-backed credential storage. Validated login/refresh credentials are safely mirrored between bot homes, but sessions are never shared.

### 6.1 File Format

In single-bot compatibility mode, candidate files live in the Codex auth directory, usually `~/.codex/`. If `CODEX_AUTH_DIR` is set, FoxClaw uses that directory. Multi-bot mode treats that directory as its candidate source and stores isolated bot copies under `~/.foxclaw/codex/telegram/bot<id>/home/`.

Recommended layout:

```text
~/.codex/
  auth.json -> /home/alice/.codex/auth.json_personal
  auth.json_personal
  auth.json_team
  auth.json_plus_trial
```

FoxClaw recognizes candidate names in these forms:

- `auth.json_<name>`
- `auth.json.<name>`
- `auth.json-<name>`

`auth.json` is what Codex currently uses. When switching accounts, FoxClaw points `auth.json` at one candidate. Candidate contents are Codex-generated JSON and should not be hand-written. In multi-bot mode, FoxClaw mirrors a candidate only when its account identity matches and its refresh timestamp is newer, preventing a same-name candidate from overwriting a different account.

If you already have a working `auth.json`, you can save it as a candidate:

```bash
cp -L ~/.codex/auth.json ~/.codex/auth.json_personal
```

The safer path is adding candidates from the phone with `/auth add <name>`.

### 6.2 Login Commands

- `/login_device`: starts ChatGPT device login for the current `auth.json`. FoxClaw sends a login URL, short code, login id, and cancel command.
- `/login_cancel [id]`: cancels an in-progress device login.
- `/logout confirm`: logs out the current Codex account.
- `/auth add <name>`: adds a candidate account. For example, `/auth add work` creates `auth.json_work` and starts device login.

`/auth add <name>` flow:

1. FoxClaw prepares `auth.json_<name>`.
2. It temporarily points `auth.json` at that candidate.
3. It restarts app-server so Codex writes into the new candidate.
4. It sends the login URL and short code.
5. You complete login in the browser.
6. The candidate appears in `/auth`.

If the login is cancelled or fails, FoxClaw tries to restore the previous auth target and remove the unfinished candidate.

### 6.3 The `/auth` Panel

`/auth` lists candidate accounts, the current account, and the auth directory. It also provides buttons for switching, disabling, login, and reload. In multi-bot mode the panel names the `@botname` runtime being managed, because private chats, groups, and topics on one bot share that bot's current auth. The `5h|7d` numbers before each filename are the last recorded remaining percentages for the two quota windows; the current auth is refreshed when the panel opens, while other candidates are not switched merely to query quota.

Approximation:

```text
Codex auth
Current: auth.json_personal
Auth dir: /home/alice/.codex
Candidates: 2
Quota remaining: 5h|7d|auth
1. 20|25|auth.json_personal * [enabled]
2. --|--|auth.json_team [enabled]

[✅ 20|25|auth.json_personal] [✅]
[🔐 --|--|auth.json_team]     [✅]
[🛡️ Access]             [🔑 Login]
[🔄 Reload auth]
```

The right-side `✅` / `⏸️` button shows the current state. Tapping it toggles enabled/disabled, and the refreshed list shows the new state. `--|--` means no quota snapshot has been observed for that candidate yet.

Equivalent commands:

- `/auth` or `/auth list`: show candidates.
- `/auth use <n>`: switch to candidate n and restart app-server.
- `/auth enable <n>`: let candidate n participate in auto-rotation.
- `/auth disable <n>`: skip candidate n during auto-rotation.
- `/auth reload` or `/auth_reload`: restart app-server and reload the current `auth.json`.

If the requesting bot runtime has active turns, pending approvals, pending user inputs, or MCP elicitations, FoxClaw refuses manual auth switching to avoid changing accounts mid-request; another idle bot is unaffected.

### 6.4 How Auto-Rotation Works

When Codex reports a usage limit, missing login, expired auth, or similar auth error, FoxClaw tries to rotate automatically:

1. Record the failed candidate.
2. Select the next enabled candidate that has not already failed in this retry cycle.
3. Point `auth.json` at that candidate.
4. Restart `codex app-server` so the new auth is loaded.
5. Retry the failed request with the new account.

Disabled candidates are skipped. If no candidate is available, FoxClaw reports the error back to the phone and stops retrying.

Example account layout:

```text
auth.json_personal     # primary account
auth.json_team         # Team or work account
auth.json_plus_trial   # trial account
auth.json_backup       # backup account, enable or disable as needed
```

## 7. Daily Workflow

1. Enter the project directory on your computer and make sure Codex works.
2. From your phone, send `/new /home/alice/Projects/app`, or use `/threads` to open an existing thread.
3. Use `/setup` to choose model, effort, access, and Agent/Plan mode.
4. Send a task, for example: `Fix the failing test and run the related test suite.`
5. Step away from the computer and watch progress on your phone.
6. Approve or deny command and file-change requests from Telegram.
7. To observe a task started from Codex CLI, use `/threads`, then tap `👀` or send `/watch <n>`.
8. When quota is hit, let `/auth` candidates auto-rotate, or switch manually with `/auth use <n>`.

## 8. Safety

- Do not share `TG_BOT_TOKENS`, `TG_BOT_TOKEN`, `~/.codex/auth.json*`, or `.env`.
- Do not use `/`, `/home`, `/Users`, or your whole home directory as the first `DEFAULT_CWD`.
- When unsure, use `/permissions read-only` or select `Read-only` in `/setup`.
- Group mode still only accepts `TG_ALLOWED_USER_ID`, but use trusted groups.
- Multi-account files are Codex login credentials. Treat backups and sync tools accordingly.

## 9. More Reading

- [Beginner Install Guide](./install-for-beginners.md)
- [Agent-Assisted Install](./agent-assisted-install.md)
- [Troubleshooting](./troubleshooting.md)
