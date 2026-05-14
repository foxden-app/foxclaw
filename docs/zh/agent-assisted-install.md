# Agent 辅助安装

如果目标电脑上已经有能执行 shell、读写文件、检查服务状态的编码 agent，优先用这条路径。它比手动一步步复制命令更快，也更容易发现本机环境里的阻塞点。

适合使用 Codex、OpenClaw、QwenPaw、Hermes、OpenCode、Kimi CLI，或者任何可以在目标机器上运行命令的 agent。

## 你需要准备

先准备这几个值：

- `TG_BOT_TOKEN`：从 `@BotFather` 拿到的 Telegram bot token
- `TG_ALLOWED_USER_ID`：你的 Telegram 数字用户 ID
- `DEFAULT_CWD`：希望 Codex 默认工作的目录

后续再配置群组或话题时才需要：

- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

第一次请先用 Telegram 私聊跑通。群组和话题模式等私聊稳定后再开。

## 复制给 agent 的安装提示词

把下面这段发给目标电脑上的 agent：

```text
请在这台机器上安装 FoxClaw。

发布包：
@foxden-app/foxclaw

先使用 Telegram 私聊模式。除非我明确提供 TG_ALLOWED_CHAT_ID 或 TG_ALLOWED_TOPIC_ID，否则不要配置群组/话题模式。

必需配置：
TG_BOT_TOKEN=<把 token 粘贴在这里>
TG_ALLOWED_USER_ID=<把 Telegram 数字用户 ID 粘贴在这里>
DEFAULT_CWD=<把绝对工作目录粘贴在这里>

任务：
1. 先检查机器环境。如果已经存在 FoxClaw 服务，先报告再改服务。
2. 确保 Node.js 24+ 可用；如果没有，请用 nvm 安装或切到 Node 24。
3. 确保 Codex CLI 存在并且已经登录。如果需要登录，停下来告诉我具体要执行什么。
4. 用 npm install -g @foxden-app/foxclaw@latest 安装或升级 FoxClaw。
5. 运行 foxclaw init，然后写入 ~/.foxclaw/.env。不要打印或提交 bot token。
6. 运行 foxclaw doctor。
7. 用 foxclaw start 启动 FoxClaw。
8. 让我在 Telegram bot 里发送 /help 和 /status。
9. 验证最终状态：
   - Linux 上 foxclaw.service 处于 active/enabled
   - foxclaw status 可以正常输出
10. 汇报执行过的命令、最终状态和后续看日志的命令。请隐藏 TG_BOT_TOKEN，不要打印完整 token 或完整 .env。
```

## 安全注意事项

- 不要把 bot token 粘贴到公开 issue、公开聊天或代码仓库。
- 不要提交 `.env`。
- 汇报结果时隐藏 `TG_BOT_TOKEN`。
- 第一次安装不要把 `/`、整个 `/Users`、整个 `/home` 或完整 home 目录设为 `DEFAULT_CWD`。
- 日常启动用 `foxclaw start`；只有排障时才用前台模式 `foxclaw serve`。
