# DeepSeek Harness 后端

FoxClaw 直接启动 DSH 的 `acp` profile，复用 Telegram 的任务进度、工具状态、最终回答、排队和中断功能。模型与推理档位读取 DSH 当前会话提供的选项；每个 Bot、聊天和话题分别保存会话与设置。

## 接入现有 Bot

在 FoxClaw 的 `.env` 中增加：

```dotenv
DSH_ENABLED=true
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness
```

DSH 源码目录需已安装依赖并准备好本机 native addon。源码模式使用 FoxClaw 的 Node 启动 `apps/cli/src/bin.ts`，从 DSH 目录加载 `tsx`。Linux 开发环境可先在 DSH 仓库执行 `pnpm install` 和 `pnpm run build:native-system`，其他平台按 DSH 自身安装说明准备。

如果使用已安装的 CLI，则用 `DSH_CLI_BIN=/absolute/path/to/dsh` 替代 `DSH_SOURCE_DIR`；也支持 CLI 的 `.js`、`.mjs` 或 `.cjs` 入口。两项同时设置时优先源码目录。

重启 FoxClaw 后，在现有 Codex 或 Antigravity Bot 中发送 `/backend dsh`，再发送 `/setup`。切回原后端后，原后端的会话和设置会恢复。正在执行任务时，先 `/interrupt` 再切换后端。

## 独立 DSH Bot

```dotenv
CODEX_BOT_TOKENS=
DSH_BOT_TOKEN=123456:your-independent-bot-token
DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness
TG_ALLOWED_USER_ID=123456789
DEFAULT_CWD=/absolute/path/to/workspace
```

`DSH_BOT_TOKEN` 自动启用 DSH，必须与其他后端的 Bot token 不同。独立 DSH 模式无需 Codex 或 Antigravity；执行 `foxclaw doctor` 检查，再正常启动服务。当前 DSH 接入范围是 Telegram，微信仍使用已有后端。

## 配置与操作

| 配置 | 默认值 / 用途 |
| --- | --- |
| `DSH_HOME` | DSH 原有 home，通常 `~/.dsh`；复用其凭据、profile 和持久会话 |
| `DSH_PROFILE` | `acp`；自定义 profile 必须提供 ACP、模型控制和 `permissionPresets` 服务 |
| `DSH_PATCHES` | JSON 数组，如 `["/absolute/path/to/patch.yml"]`；按顺序传入 DSH |
| `DSH_STARTUP_TIMEOUT_MS` | `60000`；首次初始化 profile 的最长等待时间 |
| `DEFAULT_SANDBOX_MODE` | 初始权限，支持 `read-only`、`workspace-write`、`danger-full-access` |

Provider 与 API key 沿用 DSH 配置。使用环境变量的 provider，可将相应变量（如 `DEEPSEEK_API_KEY`）加入 FoxClaw `.env`，DSH 子进程会继承。这里不使用 Codex/AGY 的账号轮转或认证同步。

| 操作 | 用途 |
| --- | --- |
| `/setup` | 模型、推理档位、权限、排队/中断接管、会话与插件配置面板 |
| `/models`、`/model <provider/model>` | 选择 DSH 模型；`/model default` 恢复会话初始模型 |
| `/effort`、`/effort <档位>` | 使用当前模型提供的推理档位；切换模型会重置为该模型默认档位 |
| `/permissions read-only|default|full-access` | 只读、工作区写入、完全访问；也可从面板选择 |
| `/threads`、`/open <会话 ID>` | 列出并恢复 DSH 持久会话 |
| `/new [目录]` | 新会话，可指定工作目录 |
| `/active queue|steer`、`/queue`、`/steer <消息>`、`/interrupt` | 排队、中断接管与取消 |
| `/plugins` | 查看 profile 显式插件依赖和额外 patch 路径 |

权限通过随桥加载的 `foxclaw-permissions` 插件设置 DSH 原生 preset，作用于根 Agent，子 Agent 按 DSH 自身规则继承。DSH 发出的工具审批会显示“允许本次 / 拒绝”按钮，中断或退出时取消等待中的审批。任务执行中不能修改权限。

## 插件与支持边界

`/plugins` 展示 profile 的显式依赖和配置 patch，并非所有运行中的内置插件清单。安装或移除沿用 DSH 命令，使用与 FoxClaw 一致的 `DSH_HOME` 和 profile，完成后重启 FoxClaw：

```bash
dsh plugin --profile acp add <package>
dsh plugin --profile acp remove <package>
```

源码模式下，可用 `node --import tsx/esm apps/cli/src/bin.ts plugin --profile acp ...` 在 DSH 仓库执行。FoxClaw 目前不提供聊天内安装/移除插件按钮。

进度来自 ACP 的已提交消息和工具事件，不是模型原始 token 流。图片在 ACP 声明支持时原生发送，其余附件传入本地路径。DSH 当前 ACP 未提供历史消息回放、会话分叉、重命名、Agent/Plan 切换等接口；对应 Codex 专用按钮不会出现在 DSH 面板。

ACP 当前仅报告上下文占用，不提供逐轮输入、输出及缓存 token 消耗；DSH 状态页会明确说明统计未提供。

## 开发验证

普通 DSH 测试使用不需要 API key 的 ACP 子进程 fixture。真实源码联调使用 DSH 自带的控制面 fixture，不调用付费模型：

```bash
FOXCLAW_DSH_TEST_SOURCE_DIR=/absolute/path/to/deepseek-harness \
DSH_TELEMETRY_DISABLED=1 node --test --import tsx src/dsh/source.integration.test.ts
```

联调使用临时 home 和会话目录，验证模型/推理设置、原生权限日志、恢复、工具事件和取消。未配置源码路径时跳过此项。

先执行 `npm run build`，再追加 `FOXCLAW_DSH_TEST_BUILT=1` 可验证编译后的后端和随包发布的权限插件。
