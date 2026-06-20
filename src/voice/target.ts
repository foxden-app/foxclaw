export type TelegramVoiceTarget = {
  botId: string;
  botToken: string;
};

export function inferTelegramBotId(codexHome: string | null | undefined): string | null {
  if (!codexHome) return null;
  const match = codexHome.match(/(?:^|[\\/])(bot\d+)(?:[\\/]|$)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function resolveTelegramVoiceTarget(tokens: string[], requestedBotId: string | null): TelegramVoiceTarget {
  if (requestedBotId) {
    const numericId = requestedBotId.replace(/^bot/i, '');
    const matched = tokens.find(token => token.startsWith(`${numericId}:`));
    if (matched) return { botId: `bot${numericId}`, botToken: matched };
    throw new Error(`No configured Telegram token matches ${requestedBotId}. Pass --bot-id for a configured bot.`);
  }
  if (tokens.length === 1) {
    const botToken = tokens[0]!;
    const numericId = botToken.slice(0, botToken.indexOf(':'));
    if (/^\d+$/.test(numericId)) {
      return { botId: `bot${numericId}`, botToken };
    }
  }
  throw new Error('Cannot infer the Telegram bot from this Codex session. Pass --bot-id <bot-id>.');
}
