---
name: telegram-media-delivery
description: 通过 FoxClaw 将 Codex 已生成或找到的图片、封面、截图、视频、GIF 或其他媒体文件直接发送到当前 Telegram 会话。需要把视觉产物交付给用户且不应要求用户手动执行 FoxClaw 命令时使用。
---

# Telegram 媒体投递

把已经完成的图片、视频或其他媒体文件直接发送到当前 FoxClaw Telegram 私聊，不要让用户手动下载或操作 `/media`。

## 操作流程

1. 确认文件已经完整生成，并优先使用绝对路径。
2. 图片优先使用 `.jpg`、`.jpeg`、`.png` 或 `.webp`。
3. 视频优先使用可流式播放的 `.mp4`，编码建议 H.264/AAC；`.mov` 可尝试发送，但客户端兼容性不如 MP4。
4. GIF 使用 `.gif`，FoxClaw 会按 Telegram animation 发送。
5. 执行：

```bash
foxclaw send-media "/文件的绝对路径/output.mp4" "简短说明"
```

6. 命令成功即表示 Telegram 已接收媒体；随后简短告知用户已经发送。

FoxClaw 会从 `CODEX_HOME` 推断当前 Telegram bot；单 bot 默认 runtime 会从唯一配置的 token 补全 bot ID。随后从本地数据库读取该 bot 最近记录的私聊，并调用 Telegram `sendPhoto`、`sendVideo`、`sendAnimation` 或 `sendDocument`。不要读取、打印或泄露 Telegram bot token。

文件已经存在时直接发送，不要重新生成。只有 FoxClaw 明确报告没有记录私聊时，才请用户对当前 bot 发送一次 `/status`；仅在自动会话推断确实不可用时使用 `--bot-id <bot-id>` 或 `--chat-id <chat-id>`，不要凭猜测指定其他 bot。

## 大视频

公网 Telegram Bot API 对大文件上传限制更严格。25 分钟视频通常应先压成可流式播放 MP4，并尽量控制体积；如果文件明显超过几十 MB，优先建议 FoxClaw 主机配置 Local Bot API Server，并设置：

```bash
TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081
TELEGRAM_BOT_API_TIMEOUT_MS=1800000
```

Local Bot API Server 支持更大的上传体积；公网 Bot API 失败时，不要反复重试同一个大文件，先压缩或改用本地 Bot API Server。
