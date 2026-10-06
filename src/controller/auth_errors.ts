import { CodexAuthRotationReason } from './state_types.js';
import { stringOrNull } from './shared_helpers.js';

export function classifyCodexAuthRotationError(params: any): CodexAuthRotationReason | null {
  const collected = collectCodexErrorText(params);
  if (isChatGptBackendAccessBlocked(collected)) {
    return null;
  }
  const code = stringOrNull(params?.error?.codexErrorInfo) ?? stringOrNull(params?.error?.code);
  const message = stringOrNull(params?.error?.message) ?? '';
  const text = `${code ?? ''}\n${message}\n${collected}`;
  if (isCodexAuthInvalidError(text)) {
    return 'auth_invalid';
  }
  if (isCodexQuotaLimitError(text)) {
    return 'quota_limited';
  }
  if (code && /auth|unauthorized|forbidden|login/i.test(code)) {
    return 'auth_invalid';
  }
  return /(not authenticated|unauthorized|forbidden|sign in|log in|login|auth)/i.test(message)
    ? 'auth_invalid'
    : null;
}

export function isCodexAuthInvalidError(text: string): boolean {
  return /token[_\s-]?invalidated/i.test(text)
    || /authentication token has been invalidated/i.test(text)
    || /\b401\s+unauthorized\b/i.test(text)
    || /\bunauthorized\b/i.test(text)
    || /\bnot authenticated\b/i.test(text)
    || /\bsign in again\b/i.test(text)
    || /\blog in again\b/i.test(text);
}

export function isCodexQuotaLimitError(text: string): boolean {
  return /usageLimitExceeded/i.test(text)
    || /you['’]?ve hit your usage limit/i.test(text)
    || /\busage limit(?:s)?\b/i.test(text)
    || /\brate limit(?:ed|s)?\b/i.test(text)
    || /\btoo many requests\b/i.test(text)
    || /\binsufficient[_\s-]?quota\b/i.test(text)
    || /\bquota exceeded\b/i.test(text)
    || /\bbilling hard limit\b/i.test(text)
    || /\bcredits? exhausted\b/i.test(text)
    || /\bout of credits?\b/i.test(text)
    || /\bcredits? limit\b/i.test(text);
}

export function formatCodexNotificationError(params: any): string {
  const collected = collectCodexErrorText(params);
  const known = formatKnownCodexAccessError(collected);
  if (known) {
    return known;
  }
  const message = stringOrNull(params?.error?.message);
  if (message) {
    return clipUserFacingError(cleanUserFacingError(message));
  }
  const code = stringOrNull(params?.error?.codexErrorInfo) ?? stringOrNull(params?.error?.code);
  if (code) {
    return clipUserFacingError(cleanUserFacingError(code));
  }
  return clipUserFacingError(cleanUserFacingError(JSON.stringify(params?.error ?? params ?? {})));
}

export function isRetryableCodexTransportError(params: any): boolean {
  if (params?.willRetry !== true) {
    return false;
  }
  const errorInfo = params?.error?.codexErrorInfo;
  return Boolean(errorInfo && typeof errorInfo === 'object' && 'responseStreamDisconnected' in errorInfo);
}

export function collectCodexErrorText(params: any): string {
  const parts = [
    stringOrNull(params?.error?.message),
    stringOrNull(params?.error?.additionalDetails),
    stringOrNull(params?.additionalDetails),
    stringOrNull(params?.error?.codexErrorInfo),
    stringOrNull(params?.error?.code),
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) {
    return parts.join(' ');
  }
  try {
    return JSON.stringify(params?.error ?? params ?? {});
  } catch {
    return String(params?.error ?? params ?? '');
  }
}

export function formatKnownCodexAccessError(raw: string): string | null {
  if (!isChatGptBackendAccessBlocked(raw)) {
    return null;
  }
  const ray = raw.match(/\bcf-ray:\s*([A-Za-z0-9-]+)/i)?.[1]
    ?? raw.match(/\bRay ID:\s*([A-Za-z0-9-]+)/i)?.[1]
    ?? null;
  return `ChatGPT backend 403 Forbidden: service network/proxy/IP is blocked, not necessarily auth.json invalid. Check HTTP_PROXY/HTTPS_PROXY in the FoxClaw env file and restart FoxClaw${ray ? ` (cf-ray: ${ray})` : ''}.`;
}

export function isChatGptBackendAccessBlocked(raw: string): boolean {
  const value = raw.toLowerCase();
  const targetsChatGptBackend = value.includes('chatgpt.com/backend-api')
    || value.includes('wss://chatgpt.com/backend-api');
  const isForbidden = value.includes('403 forbidden')
    || value.includes('status 403')
    || value.includes('httpstatuscode":403')
    || value.includes('httpstatuscode:403');
  const looksLikeHtmlBlock = value.includes('<html')
    || value.includes('text/html')
    || value.includes('cf-ray')
    || value.includes('unable to load site')
    || value.includes('if you are using a vpn');
  return targetsChatGptBackend && isForbidden && looksLikeHtmlBlock;
}

export function cleanUserFacingError(raw: string): string {
  return raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clipUserFacingError(raw: string, limit = 900): string {
  const cleaned = raw.trim();
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit - 3)}...`;
}
