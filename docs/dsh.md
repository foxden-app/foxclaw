# DeepSeek Harness backend

FoxClaw launches DSH's shipped `acp` profile and reuses Telegram progress, tool status, final answers, queueing, and interruption. Models and reasoning levels come from the current DSH session. Bindings and settings are stored separately for each bot, chat, and topic.

## Existing bot

Add to FoxClaw's `.env`:

```dotenv
DSH_ENABLED=true
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness
```

Prepare DSH dependencies and its platform native addon first. Source mode runs `apps/cli/src/bin.ts` with FoxClaw's Node and resolves `tsx` from the DSH repository. For Linux development, run `pnpm install` and `pnpm run build:native-system` inside DSH; follow DSH's installation instructions for other platforms.

For an installed CLI, replace `DSH_SOURCE_DIR` with `DSH_CLI_BIN=/absolute/path/to/dsh`. A `.js`, `.mjs`, or `.cjs` entry point also works. Source mode takes precedence when both are set.

Restart FoxClaw, then send `/backend dsh` and `/setup` to your Codex or Antigravity bot. Switching back restores the previous backend's session and settings. Interrupt an active turn before switching backends.

## Dedicated bot

```dotenv
CODEX_BOT_TOKENS=
DSH_BOT_TOKEN=123456:your-independent-bot-token
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
```

`DSH_BOT_TOKEN` enables DSH automatically and must differ from other backend tokens. Standalone DSH requires neither Codex nor Antigravity. Run `foxclaw doctor` and start the service normally. DSH currently connects through Telegram; Weixin uses the existing backends.

## Configuration and controls

| Setting | Default / purpose |
| --- | --- |
| `DSH_HOME` | Existing DSH home, normally `~/.dsh`; credentials, profiles, and persisted sessions |
| `DSH_PROFILE` | `acp`; custom profiles must expose ACP, model controls, and `permissionPresets` |
| `DSH_PATCHES` | JSON array, e.g. `["/absolute/path/to/patch.yml"]`, applied in order |
| `DSH_STARTUP_TIMEOUT_MS` | `60000`; startup timeout, including first profile initialization |
| `DEFAULT_SANDBOX_MODE` | Initial access: `read-only`, `workspace-write`, or `danger-full-access` |

Provider credentials remain managed by DSH. Provider environment variables such as `DEEPSEEK_API_KEY` can be placed in FoxClaw's `.env` and are inherited by DSH. Codex/AGY account rotation and auth synchronization are not used by this backend.

| Control | Purpose |
| --- | --- |
| `/setup` | Models, reasoning, permissions, queue/interrupt mode, sessions, and plugin configuration |
| `/models`, `/model <provider/model>` | Native model selection; `/model default` restores the session's initial model |
| `/effort`, `/effort <level>` | Reasoning choices advertised by the current model; changing models resets reasoning to the new model's default |
| `/permissions read-only\|default\|full-access` | Read-only, workspace-write, or full-access, also available as buttons |
| `/threads`, `/open <session ID>` | List and resume persisted DSH sessions |
| `/new [directory]` | New session with an optional working directory |
| `/active queue\|steer`, `/queue`, `/steer <message>`, `/interrupt` | Queueing, interruption, and takeover |
| `/plugins` | Profile dependencies and configured patch paths |

The bundled `foxclaw-permissions` plugin applies native DSH permission presets to root agents; children inherit according to DSH's rules. Native approval requests become Allow once / Reject buttons. Interrupting or stopping cancels pending approvals. Access changes require an idle turn.

## Plugins and limitations

`/plugins` shows explicit profile dependencies and configured patches, rather than a complete inventory of active built-in plugins. Install/remove packages with DSH's own command, using the same `DSH_HOME` and profile, then restart FoxClaw:

```bash
dsh plugin --profile acp add <package>
dsh plugin --profile acp remove <package>
```

In source mode, run `node --import tsx/esm apps/cli/src/bin.ts plugin --profile acp ...` inside the DSH repository. There are currently no chat buttons for installing/removing packages.

Progress follows committed ACP messages and tool events, rather than raw model token streaming. Images are sent natively when advertised by ACP; other attachments are passed as local paths. The current DSH ACP surface does not expose transcript replay, forks, renaming, or Agent/Plan switching, so those Codex-specific controls are omitted.

ACP reports context occupancy rather than per-turn input/output/cache token consumption. The DSH status page explicitly marks those counts as unavailable.

## Development verification

Ordinary tests use a keyless ACP subprocess fixture. To exercise the actual source CLI with DSH's bundled control-surface fixture:

```bash
FOXCLAW_DSH_TEST_SOURCE_DIR=/absolute/path/to/deepseek-harness \
DSH_TELEMETRY_DISABLED=1 node --test --import tsx src/dsh/source.integration.test.ts
```

This uses temporary DSH home/session directories and verifies model/reasoning selection, native permission logs, resume, tools, and cancellation without paid model calls. It is skipped when the source path is unset.

Run `npm run build` first and add `FOXCLAW_DSH_TEST_BUILT=1` to verify the compiled backend and packaged permission plugin.
