---
name: telegram-voice-delivery
description: 通过 FoxClaw 将 Codex 已生成或找到的语音、解说、播客等音频文件直接发送到当前 Telegram 会话。需要把音频交付给用户且不应要求用户手动执行 FoxClaw 命令时使用。
---

# Telegram 语音投递

把已经完成的音频直接发送到当前 FoxClaw Telegram 私聊，不要让用户操作 `/voice`。

## 操作流程

1. 确认音频文件已经完整生成。
2. 优先使用适合 Telegram 语音播放的 `.ogg` 或 `.opus`；也支持 `.oga`、`.mp3` 和 `.m4a`。
3. 文件不得超过 50MB。
4. 执行：

```bash
foxclaw send-voice "/音频的绝对路径/audio.ogg" "简短说明"
```

5. 命令成功即表示 Telegram 已接收该语音；随后简短告知用户已经发送。

FoxClaw 会从 `CODEX_HOME` 推断当前 Telegram bot；单 bot 默认 runtime 会从唯一配置的 token 补全 bot ID。随后从本地数据库读取该 bot 最近记录的私聊，并调用 Telegram `sendVoice`。不要读取、打印或泄露 Telegram bot token。

音频已经存在时直接发送，不要重新生成。只有 FoxClaw 明确报告没有记录私聊时，才请用户对当前 bot 发送一次 `/status`；仅在自动会话推断确实不可用时使用 `--bot-id <bot-id>` 或 `--chat-id <chat-id>`，不要凭猜测指定其他 bot。
