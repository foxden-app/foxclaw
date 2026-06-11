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

- `TG_BOT_TOKENS`: one or more `@BotFather` tokens separated by commas. The legacy single-bot `TG_BOT_TOKEN` setting remains compatible. In multi-bot mode, if the exact `TG_BOT_TOKEN` value also appears in `TG_BOT_TOKENS`, that bot uses the default/shared-terminal runtime.
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

On macOS, `foxclaw start` manages launchd. Check launchd state and startup logs with:

```bash
launchctl print "gui/$(id -u)/app.foxden.foxclaw"
tail -f ~/.foxclaw/logs/launchd.err.log ~/.foxclaw/logs/service.log
```

For foreground debugging, stop the background service and run:

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
- `/update`: upgrade FoxClaw, attempt to update an npm/pnpm-managed Codex CLI, run checks, and restart the service; it refuses while any Telegram bot runtime, an enabled Weixin default runtime, or an auth mirror write is busy, then reports both FoxClaw and Codex CLI version changes through the initiating bot after restart.

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

This is a key FoxClaw feature. Codex auth is usually stored at `~/.codex/auth.json`. FoxClaw stores multiple accounts as candidate files and switches which candidate the active `auth.json` points to. In `TG_BOT_TOKENS` mode, each bot has an isolated Codex home, app-server, and current candidate by default, so bots can run and switch accounts independently; isolated Telegram runtimes force file-backed credential storage. Validated login/refresh credentials are safely mirrored between bot homes, but isolated sessions are never shared.

To keep one Telegram bot interoperable with terminal Codex sessions, put the same token in both `TG_BOT_TOKENS` and `TG_BOT_TOKEN`. That bot uses the default `CODEX_HOME` and default auth, so `/threads` can see local terminal sessions; its `/auth` switches also affect the terminal default auth. Bots listed only in `TG_BOT_TOKENS` stay isolated.

### 6.1 File Format

In single-bot compatibility mode, candidate files live in the Codex auth directory, usually `~/.codex/`. If `CODEX_AUTH_DIR` is set, FoxClaw uses that directory. Multi-bot mode treats that directory as its candidate source and stores isolated bot copies under `~/.foxclaw/codex/telegram/bot<id>/home/`. A default/shared-terminal bot does not get an isolated copy; it uses the default auth directory directly.

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

`auth.json` is what Codex currently uses. When switching accounts, FoxClaw points `auth.json` at one candidate. Candidate contents are Codex-generated JSON and should not be hand-written. In multi-bot mode, FoxClaw mirrors a candidate only when its account identity and identifiable ChatGPT user/email identity are compatible, its refresh timestamp is newer, and the active app-server verifies it against the ChatGPT usage endpoint, preventing a same-name candidate from overwriting a different account or Team seat. Before an auth switch or reload, FoxClaw also searches the other Codex homes for a newer compatible credential, restores it into the requesting runtime, then verifies and mirrors it after restart.

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

Device-code login is the Codex login path for headless hosts. Your ChatGPT account may not allow it by default. Before using `/login_device`, `/auth add <name>`, or the Login button in the `/auth` panel, open `https://chatgpt.com/`, click your username in the lower-left corner, go to Settings > Security, and enable device code authorization for Codex. Workspace or enterprise accounts may require a workspace admin to allow device-code login.

Use this carefully: a device code can be stolen by phishing and acts as a login grant. Enter the code only on the ChatGPT/Codex login page you trust. Never send the device code to another person or paste it into an untrusted page.

`/auth add <name>` flow:

1. FoxClaw prepares `auth.json_<name>`.
2. It temporarily points `auth.json` at that candidate.
3. It restarts app-server so Codex writes into the new candidate.
4. It sends the login URL and short code.
5. You complete login in the browser.
6. The candidate appears in `/auth`.

If the login is cancelled or fails, FoxClaw tries to restore the previous auth target and remove the unfinished candidate.

### 6.3 The `/auth` Panel

`/auth` lists candidate accounts, the current account, and the auth directory. It also provides buttons for switching, disabling, login, and reload. In multi-bot mode the panel names the `@botname` runtime being managed, because private chats, groups, and topics on one bot share that bot's current auth. The panel shows 8 candidates per page and supports paging, `All / Enabled / Attention` filters, and `/auth list <keyword>` filename search for large local inventories. Panel text and buttons omit the repeated `auth.json_` prefix from standard candidate filenames, so `auth.json_personal` on disk renders as `personal`; files are not renamed, and search and commands still operate on the original candidates. `/auth use <n>` always uses the full-list candidate number, independent of panel paging.

Candidate rows are prefixed with observed `window:remaining-percent` values. For example, a Plus account may show `5h:20|7d:25`, while an account with one monthly window may show `30d:97`. Buttons use a compact two-number `primary|secondary` form such as `20|25`; unknown values render as `—`. The current auth quota is refreshed when the panel opens; other candidates are not switched merely to query quota. When multiple bot runtimes have recently used the same ChatGPT quota identity, FoxClaw combines their cached quota snapshots by verified user/email identity under the account, so one bot's `/auth` panel can show quota information learned by another bot without mixing different seats on the same Team account.

Approximation:

```text
Codex auth
Current: personal
Auth dir: /home/alice/.codex
Candidates: 2
Quota remaining: window:percent|auth
1. 5h:20|7d:25|personal * [Plus · ready · refreshed 2h ago]
2. --|team [quota unknown]

[✅ 20|25|personal] [✅]
[🔐 —|—|team]       [✅]
[☑️ All] [Enabled] [Attention]
[🛡️ Access]             [🔑 Login]
[🔄 Reload auth]
```

The right-side `✅` / `⏸️` button controls whether the candidate participates in auto-rotation. Tapping it toggles enabled/disabled, and the refreshed list shows the new state. Tapping a candidate switches auth, restarts that runtime, and refreshes the same panel with its buttons intact so you can switch again immediately. `--` means no quota snapshot has been observed for that candidate yet. Health summaries distinguish ready, low quota, quota exhausted, quota unknown, not recently refreshed, API key, invalid auth file, and needs login repair states.

When an auth candidate has already failed while in use and FoxClaw cannot recover a newer same-account credential from local mirror or cross-node sync, it is marked as `needs login repair`. These candidates are skipped by auto-rotation and proactive refresh, and are hidden from the `Enabled` filter. Their row shows a `?` action. Tapping it opens two choices: Login repair starts device-code login with that candidate selected; Delete removes the candidate from canonical storage and all local bot runtimes, and clears cached quota for it.

`/auth refresh all` is a command-only maintenance action because ChatGPT refresh tokens are rotated. It is allowed only when every Telegram runtime, the Weixin runtime, approvals, inputs, logins, and auth mirroring are idle. The command first shows a risk confirmation: if OpenAI/Codex consumes an old refresh token but the new token cannot be saved because of network, process, or disk failure, that candidate may require device login or phone verification again. After confirmation, FoxClaw visits every ChatGPT candidate, asks Codex to force-refresh tokens with `account/read refreshToken=true`, verifies the result through the usage endpoint, mirrors successful candidates, restores the original current auth, and shows a summary.

OpenAI does not publish a fixed ChatGPT refresh-token lifetime or an old-token replay grace period. Codex refreshes automatically when an access token approaches expiry; when it cannot parse the access-token `exp`, current Codex uses a `last_refresh` fallback of about 8 days. The panel labels candidates without a refresh record in that interval as `not recently refreshed`. FoxClaw also checks once per hour in the background: if an enabled ChatGPT candidate has a `last_refresh` older than 9 days, FoxClaw proactively refreshes that batch only when every runtime is idle, no approvals/inputs/logins/auth mirror writes are active, and the node holds the cross-node refresh lease. The private bot chat shows one proactive-refresh status message and edits it to the final result. Newer candidates continue through same-node mirroring and cross-node sync, and bursty mirror/cross-node refresh notices are grouped into short summary messages.

### 6.4 Cross-Node Auth Sync

Cross-node auth sync is disabled by default. It is for multiple machines you control that share the same legally owned ChatGPT auth candidate pool, so a token refreshed by Codex on one node can be copied to the others. v1 uses Telegram Bot-to-Bot private messages to carry encrypted files, so it does not require public IPs or FRP. The recommended default is one contact bot per node; other bots on the same node keep using local auth mirroring. In multi-bot mode, the default contact is the first token in `TG_BOT_TOKENS`. The contact bot private chat reports send, receive, queue, import, failure, recovery-query, and manual-intervention states; refresh/send/import bursts are grouped into summaries, while recovery and manual-intervention notices remain explicit. Remote import validation temporarily restarts the local Codex app-server; FoxClaw marks that window non-idle, and ordinary messages received during it get a short retry notice instead of running against a restarting bridge. Per-candidate validation failures are shown as candidate failures instead of overwriting the sync-system last error. Recent bot-to-bot traffic is also kept in an event ring so `/auth sync events [filter]` and `/auth sync trace <requestId>` can explain a specific candidate, peer, or request.

For the full design, safety boundaries, `.env` examples, and troubleshooting, read the [Cross-Node Auth Sync Setup Guide](./cross-node-auth-sync.md).

In `@BotFather`, repeat this for every participating bot:

1. Use the latest Telegram mobile client to open `https://t.me/BotFather?startapp`, or open the `@BotFather` profile and tap **Open App**.
2. In the BotFather MiniApp, select the contact bot that will participate in sync.
3. Open Settings / Bot Settings.
4. Find and enable **Bot-to-Bot Communication Mode**.
5. Repeat for every node contact bot; private sync requires this mode on both sender and recipient.

Do not use `/mybots` → Bot Settings → **Configure Mini App**. That configures your bot's Mini App URL, not Bot-to-Bot Communication Mode.

Example:

```dotenv
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<shared key with at least 32 bytes>
AUTH_SYNC_PEERS=@other_node_bot,@third_node_bot
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
# Optional; FoxClaw generates and persists a local node id when omitted.
AUTH_SYNC_NODE_ID=workstation-a
# Optional resource-rich mode: auto-delete unrecoverable candidates across peers.
AUTH_AUTO_DELETE_NEEDS_REPAIR=false
```

Safety boundaries:

- Telegram only carries ciphertext. Auth contents, candidate names, account ids, and `last_refresh` live inside the AES-256-GCM encrypted payload.
- FoxClaw only accepts sync files from bots listed in `AUTH_SYNC_PEERS`; wrong key, cluster, nonce, or payload validation never writes files.
- Remote imports wait for global local idleness, temporarily switch to the candidate for app-server usage validation, and only then write the candidate.
- A same-name candidate known to belong to a different account id, or to a different identifiable ChatGPT user/email under the same account, is never overwritten.
- Cross-node recovery only pulls an already-held valid peer copy and does not rotate refresh tokens during recovery. If no peer has a usable copy, it stops and asks you to maintain auth manually. The background 9-day proactive refresh separately requests the cross-node refresh lease and skips that cycle if the lease is not granted.
- When `AUTH_AUTO_DELETE_NEEDS_REPAIR=true` is enabled, or the same option is turned on in `/config`, unrecoverable candidates are deleted and propagated to peers with a delete tombstone. Private notifications collapse to an auth-pool summary: total seen, alive, and invalid-deleted.

Dual-active behavior:

- Push: after local login, Codex automatic refresh, or `/auth refresh all` succeeds and passes local mirror validation, the newer candidate is encrypted and pushed to peers.
- Pull: before auth switch or reload, FoxClaw first searches local runtimes for a newer same-account candidate; if none is found, it asks peers for a newer same-name same-account copy.
- Lease: `/auth refresh all confirm` and the background 9-day proactive refresh request a cross-node refresh lease before rotating tokens. Any busy, denying, or non-responsive peer blocks the refresh.

Commands:

- `/auth sync status`: show node id, peers, peer activity, recent sync events, pending imports, the sync-system latest error, and per-candidate failures.
- `/auth sync events [filter]`: show recent sync event records, optionally filtered by candidate, peer, request id, kind, stage, or detail.
- `/auth sync trace <requestId>`: show recent records for one request id or event id.
- `/auth sync test`: send an encrypted ping and wait for peer pong replies to verify peer config, shared key, and Bot-to-Bot private messages.
- `/auth sync push all`: manually broadcast all locally verified candidates without refreshing tokens. “Sent” does not mean the peer imported files; check `/auth sync status` and `/auth` on the peer.

Equivalent commands:

- `/auth` or `/auth list [keyword]`: show candidates, optionally filtered by filename.
- `/auth filter <all|enabled|attention>`: show all, enabled, or attention-needed candidates.
- `/auth page <n>`: open a specific page directly.
- `/auth use <n>`: switch to candidate n and restart app-server.
- `/auth enable <n>`: let candidate n participate in auto-rotation.
- `/auth disable <n>`: skip candidate n during auto-rotation.
- `/auth reload` or `/auth_reload`: restart app-server and reload the current `auth.json`.
- `/auth refresh all`: show the refresh-token rotation risk confirmation.
- `/auth refresh all confirm`: run Refresh all after accepting the token-rotation risk.
- `/auth sync status|events|trace|test|push all`: inspect, trace, test, or manually push cross-node auth sync.

If the requesting bot runtime has active turns, pending approvals, pending user inputs, or MCP elicitations, FoxClaw refuses manual auth switching to avoid changing accounts mid-request; another idle bot is unaffected.

### 6.5 How Auto-Rotation Works

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
- [Cross-Node Auth Sync Setup Guide](./cross-node-auth-sync.md)
- [Troubleshooting](./troubleshooting.md)
