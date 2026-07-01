# FoxClaw Skill 中文说明

仓库内置的 `skills/foxclaw` 是给 Codex 使用的安装技能。它的用途是让 Codex 在本机或远程 Mac 上自动完成 FoxClaw bootstrap，包括写 `.env`、安装依赖、构建、跑 `doctor`、安装 launchd 服务，并引导你完成第一次 Telegram 消息验证。

仓库还内置 `skills/telegram-voice-delivery` 和 `skills/telegram-media-delivery`。FoxClaw 启动时会把它们自动同步到每个 Telegram runtime 的 `CODEX_HOME`。当 Codex 已经生成音频、图片、封面、截图或视频时，它会直接运行 `foxclaw send-voice <path> [caption]` 或 `foxclaw send-media <path> [caption]`，从当前 `CODEX_HOME` 识别 Telegram bot，并将文件投递到该 bot 最近记录的私聊，不需要用户再输入命令。

## 适合什么时候用

- 你想让 Codex 通过 SSH 帮另一台 Mac 安装 FoxClaw。
- 你希望 agent 先检查环境，再决定如何安装 Node.js 24+、Codex CLI 和 FoxClaw。
- 你不想手动复制每一步安装命令，但愿意提供 Telegram bot token、用户 ID 和默认工作目录。

## 基本流程

1. 准备 `TG_BOT_TOKENS`（一个或多个逗号分隔的 bot token）、`TG_ALLOWED_USER_ID` 和 `DEFAULT_CWD`。
2. 让 Codex 使用 `skills/foxclaw`。
3. 如果是远程机器，提供 SSH 目标。
4. 让 Codex 执行安装、写配置、跑 `foxclaw doctor`。
5. 启动服务后，在每个配置的 Telegram bot 私聊里发送 `/help`、`/status` 和 `/auth` 验证。

## 注意事项

- 不要让 agent 把完整 bot token 打印到日志或提交到仓库。
- FoxClaw 仓库收尾提交默认使用 `中文 | English` 的双语 subject，方便国内和国际协作者同时阅读。
- 第一次请先用私聊模式跑通。
- 多个 token 会在同一服务中建立多个独立 Codex home、session 与 auth 选择；群组中必须点名或回复目标 bot。
- 同时启用微信时，微信仍使用默认 Codex runtime，不共享隔离 Telegram bot 的线程。
- 不要把整个 home 目录或根目录作为首次 `DEFAULT_CWD`。
- 只有在 `doctor` 通过、服务已启动、Telegram 首条消息验证通过后，才算安装完成。
