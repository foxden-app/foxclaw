# Cross-Node Auth Sync Setup Guide

This guide is for multiple machines you control that share the same legally owned ChatGPT auth candidate pool. It extends same-host auth mirroring across machines: when Codex refreshes a token on one node, FoxClaw can send an encrypted auth bundle to peer nodes through Telegram Bot-to-Bot private messages; when one node finds a local candidate unusable, it can pull an already-held valid peer copy.

The feature is disabled by default. It does not require a public IP, FRP, or reverse proxy, but it requires Telegram Bot-to-Bot Communication Mode.

## Scope

Use it when:

- You legally own and maintain the ChatGPT accounts and auth files.
- Multiple machines run FoxClaw, and each machine has at least one Telegram bot.
- You want auth files to stay fresh across nodes, and you allow FoxClaw to proactively refresh enabled ChatGPT candidates whose `last_refresh` is older than 9 days after it obtains the cross-node refresh lease.
- The recommended default is one contact bot per node for cross-node sync. Other bots on the same node continue to use local auth mirroring.

Do not use it when:

- The auth source is untrusted, account ownership is unclear, or you do not control every machine administrator.
- You want to force refresh-token keepalive without a cross-node lease, while nodes are busy, or for disabled candidates.
- The same bot token is being polled by multiple machines at the same time. That breaks Telegram update delivery and FoxClaw's assumptions.

## Design And Safety Model

Cross-node sync combines three active paths:

- **Push**: after local login, Codex automatic refresh, or `/auth refresh all confirm` succeeds and passes usage validation, FoxClaw sends the newer candidate to peers.
- **Pull**: before auth switch or reload, FoxClaw first searches local runtimes for a newer candidate. If none exists, it asks peers for a newer same-name, same-account candidate.
- **Lease**: before `/auth refresh all confirm` or the background 9-day proactive refresh rotates refresh tokens, FoxClaw requests a cross-node refresh lease. Any busy, denying, or non-responsive peer blocks the refresh.

Safety boundaries:

- Telegram only carries ciphertext. Candidate contents, candidate names, account ids, and `last_refresh` are inside an AES-256-GCM payload.
- FoxClaw only accepts sync files from bots listed in `AUTH_SYNC_PEERS`.
- Wrong `AUTH_SYNC_KEY`, cluster, nonce, or payload validation never writes files.
- Remote imports wait for global local idleness, then run temporary usage validation before writing a candidate.
- A same-name candidate known to belong to a different account id, or to a different identifiable ChatGPT user/email under the same account, is never overwritten.
- Sync packets do not create reply chains. FoxClaw filters by packet type, nonce, and peer allowlist to avoid bot-to-bot loops.

Telegram's official Bot Features documentation says private bot-to-bot messaging requires Bot-to-Bot Communication Mode on both sender and recipient, and it calls out loop-prevention requirements. See https://core.telegram.org/bots/features#bot-to-bot-communication

## Before You Configure

Assume two machines:

- Node A: bot `@foxclaw_node_a_bot`
- Node B: bot `@foxclaw_node_b_bot`

These are the two node contact bots. `AUTH_SYNC_PEERS` only needs peer node contact bots; you do not need to list every bot running on the same machine. In multi-bot mode, FoxClaw uses the first token in `TG_BOT_TOKENS` as the local contact bot by default. If you want bot 5 to be the contact, put bot 5's token first, or enable Bot-to-Bot for every local bot as a temporary fallback.

Each node should already work independently:

```bash
foxclaw doctor
foxclaw start
```

In a private Telegram chat with each bot, verify:

```text
/status
/auth
```

## Enable Bot-to-Bot In @BotFather

Repeat this for every participating bot:

1. Prefer the latest Telegram mobile client; some desktop or older clients do not show the setting.
2. Open `https://t.me/BotFather?startapp`, or open the `@BotFather` profile and tap **Open App**.
3. In the BotFather MiniApp, select the contact bot that will participate in auth sync.
4. Open Settings / Bot Settings.
5. Find **Bot-to-Bot Communication Mode**.
6. Enable it.
7. Repeat for every node contact bot.

Do not use `/mybots` → Bot Settings → **Configure Mini App**. That configures your bot's Mini App URL, not Bot-to-Bot Communication Mode.

Private cross-node sync requires this mode on both bots. Enabling it on only one side is usually not enough for two bots to exchange private sync packets.

If you see `Bad Request: USER_BOT_TO_BOT_DISABLED`, first confirm that both the sender contact bot and recipient contact bot have Bot-to-Bot enabled. In multi-bot mode, the sender contact is the first token in `TG_BOT_TOKENS` by default; it may not be the bot where you typed the command.

## .env Configuration

Use the same `AUTH_SYNC_KEY` and `AUTH_SYNC_CLUSTER_ID` on all nodes, but give each node a different `AUTH_SYNC_NODE_ID`.

Node A:

```dotenv
TG_BOT_TOKENS=<node-a-contact-token>,<node-a-other-bot-token>
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<shared key with at least 32 bytes>
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
AUTH_SYNC_NODE_ID=workstation-a
AUTH_SYNC_PEERS=@foxclaw_node_b_bot
```

Node B:

```dotenv
TG_BOT_TOKENS=<node-b-contact-token>,<node-b-other-bot-token>
AUTH_SYNC_ENABLED=true
AUTH_SYNC_KEY=<shared key with at least 32 bytes>
AUTH_SYNC_CLUSTER_ID=my-codex-auth-pool
AUTH_SYNC_NODE_ID=workstation-b
AUTH_SYNC_PEERS=@foxclaw_node_a_bot
```

For more peers, separate bot usernames with commas:

```dotenv
AUTH_SYNC_PEERS=@foxclaw_node_a_bot,@foxclaw_node_b_bot,@foxclaw_node_c_bot
```

Generate a shared key with a password manager or `openssl`:

```bash
openssl rand -base64 32
```

Restart FoxClaw on every node after editing config:

```bash
foxclaw restart
```

## Verification

1. In each node's bot private chat, run:

```text
/auth sync status
```

You should see the node id, peer list, and pending imports.

2. On node A, run:

```text
/auth sync test
```

Node A should report that it sent a test ping. Node B's `/auth sync status` should show a recent receive or test-state change.

Starting in 0.4.17, `/auth sync test` waits for an encrypted pong from peers. A healthy result looks like:

```text
Auth sync test complete: sent 1, replies 1.
```

If it shows `Missing replies: @peer_bot`, Telegram delivery may have succeeded, but the peer did not receive, decrypt, pass allowlist validation, or run the same auth sync configuration.

3. Use a low-risk candidate for the first broadcast. Make sure every runtime is idle, then run on node A:

```text
/auth sync push all
```

4. On node B, run:

```text
/auth sync status
/auth
```

Confirm that pending imports were processed, or that the candidate exists or has a newer timestamp.

Note: `/auth sync push all` saying “sent” only means this node successfully handed encrypted packages to Telegram. It does not prove the peer wrote files. The peer imports only when it is globally idle, usage validation succeeds, same-name candidates belong to the same account id and compatible ChatGPT user/email identity, and the remote `last_refresh` is newer than the local copy. If the local file is already equal or newer, it will not change and `Last import` may remain empty.

When cross-node sync is enabled, the contact bot private chat receives node-level notifications: local auth updates and the peers being contacted, received remote bundles and whether they were queued or immediately validated, import success/skip/failure reasons, recovery peer queries and peer replies, and a manual-intervention notice when every peer lacks an importable copy. Refresh/send/import bursts are grouped into short summaries so one candidate update does not produce separate start, receive, mirror-write, and completion messages. Recovery and manual-intervention notices remain explicit. Notifications never include auth contents, tokens, or encrypted bundle payloads.

Starting in 0.5.2, `/auth sync status` separates sync-system `Last error` from per-auth `Candidate failures`. For example, a remote candidate that returns `token_invalidated` or has an expired access token is recorded under that candidate name only; current `auth.json` health is still determined by validating the current auth usage. `local candidate is already newer or equal` is a normal skip, not an error.

Manual `/auth` switches and `/auth reload` recover from same-node local mirrors only and do not send cross-node pull requests. FoxClaw queries peers only during automatic recovery after it detects a real auth problem. Recovery timeout notifications include the request id, candidate name, peer list, and wait duration; if another auth sync message arrived from the same peer during that wait, the notification says the peer was reachable but this request timed out.

Starting in 0.5.8, `/auth sync status` also shows peer activity and the latest sync events. Use `/auth sync events [filter]` to search recent event records by candidate, peer, request id, kind, stage, or detail. Use `/auth sync trace <requestId>` when a notification includes a request id and you want the recent send/receive/result records for that request.

If an upgrade or restart interrupts remote candidate usage validation, older versions could leave `auth.json -> .auth-sync-validate-*` behind. Starting in 0.5.2, FoxClaw checks for this at startup, restores `auth.json` to the mirror-status candidate or the newest parseable real `auth.json_*` candidate in the same directory, and removes stale validation temp files.

5. Only test refresh-token rotation after you understand the risk:

```text
/auth refresh all
/auth refresh all confirm
```

With cross-node sync enabled, this command first requests a cross-node refresh lease. Any busy, denying, or timed-out peer blocks refresh.

## Troubleshooting

**`/auth sync test` does nothing**

- Confirm both bots have Bot-to-Bot Communication Mode enabled in `@BotFather`.
- Confirm `AUTH_SYNC_PEERS` contains peer `@username` values, not tokens.
- Confirm `AUTH_SYNC_KEY` and `AUTH_SYNC_CLUSTER_ID` match exactly on both sides.
- Confirm both nodes were restarted after config changes.

**A sync packet arrived but no candidate was written**

- The local node may not be globally idle. Active turns, approvals, inputs, login flows, and mirror writes make imports wait.
- Usage validation failure rejects the write.
- Same-name candidates from different account ids, or from different identifiable ChatGPT users/emails under the same account, are refused.
- Run `/auth sync events <candidate>` or `/auth sync trace <requestId>` to see the receive, validation, skip, or failure records kept by FoxClaw.

**Should I periodically run `/auth refresh all confirm` as keepalive?**

Do not force it manually on a schedule. Codex refreshes automatically when access tokens expire, and FoxClaw now proactively refreshes enabled ChatGPT candidates whose `last_refresh` is older than 9 days after the node is globally idle and obtains the cross-node refresh lease. `/auth refresh all confirm` remains a manual maintenance command for cases where you explicitly accept refresh-token rotation risk.
