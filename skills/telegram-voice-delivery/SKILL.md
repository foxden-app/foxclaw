---
name: telegram-voice-delivery
description: Deliver an audio file from Codex to the current Telegram conversation through FoxClaw. Use when Codex has generated or found speech, narration, a podcast, or another audio file that the user should receive in Telegram without manually running a FoxClaw command.
---

# Telegram Voice Delivery

Send completed audio artifacts back to the active FoxClaw Telegram conversation without asking the user to operate `/voice`.

## Workflow

1. Finish generating the audio file before attempting delivery.
2. Prefer `.ogg` or `.opus` for Telegram voice playback. `.oga`, `.mp3`, and `.m4a` are also accepted.
3. Keep the file at or below 50MB.
4. Run:

```bash
foxclaw send-voice "/absolute/path/to/audio.ogg" "Short caption"
```

5. Treat a successful command as delivery confirmation and tell the user the audio was sent.

FoxClaw infers the current Telegram bot from `CODEX_HOME`, reads that bot's remembered private chat from its local store, and calls Telegram `sendVoice`. Do not read, print, or expose Telegram bot tokens.

If an audio file already exists, send it directly instead of regenerating it. If FoxClaw reports that no private chat is remembered, ask the user to send `/status` to that bot once; use `--bot-id <bot-id>` or `--chat-id <chat-id>` only when automatic session inference is unavailable.
