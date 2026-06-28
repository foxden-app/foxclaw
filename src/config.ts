import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';
import type { ApprovalPolicyValue, SandboxModeValue } from './types.js';

export const APP_HOME = path.join(process.env.HOME || os.homedir(), '.foxclaw');
export const DEFAULT_STORE_PATH = path.join(APP_HOME, 'data', 'bridge.sqlite');
export const DEFAULT_STATUS_PATH = path.join(APP_HOME, 'runtime', 'status.json');
export const DEFAULT_LOG_PATH = path.join(APP_HOME, 'logs', 'service.log');
export const DEFAULT_LOCK_PATH = path.join(APP_HOME, 'runtime', 'bridge.lock');
export const DEFAULT_CODEX_APP_SERVER_STATE_PATH = path.join(APP_HOME, 'runtime', 'codex-app-server.json');
export const DEFAULT_CODEX_APP_SERVER_LOG_PATH = path.join(APP_HOME, 'logs', 'codex-app-server.log');
export const DEFAULT_CODEX_TELEGRAM_HOME = path.join(APP_HOME, 'codex', 'telegram');
export const DEFAULT_AUTH_SYNC_STATE_PATH = path.join(APP_HOME, 'runtime', 'auth-sync.json');
export const DEFAULT_AUTH_SYNC_TEMP_DIR = path.join(APP_HOME, 'runtime', 'auth-sync');
export const DEFAULT_ENV_PATH = path.join(APP_HOME, '.env');

let envLoaded = false;
let loadedEnvPath: string | null = null;

export function resolveEnvPath(): string {
  const explicitPath = process.env.FOXCLAW_ENV?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const cwdEnvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(cwdEnvPath)) {
    return cwdEnvPath;
  }
  return DEFAULT_ENV_PATH;
}

export function getLoadedEnvPath(): string | null {
  return loadedEnvPath;
}

export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = resolveEnvPath();
  loadedEnvPath = envPath;
  dotenv.config({ path: envPath, override: Boolean(process.env.FOXCLAW_ENV?.trim()) });
}

export interface AppConfig {
  tgBotToken: string;
  tgBotTokens: string[];
  tgMultiBotMode: boolean;
  tgDefaultRuntimeBotToken: string | null;
  tgScopeBotId: string | null;
  tgRequireExplicitGroupAddressing: boolean;
  tgAllowedUserId: string;
  tgAllowedChatId: string | null;
  tgAllowedTopicId: number | null;
  codexCliBin: string;
  codexAppAutolaunch: boolean;
  codexAppLaunchCmd: string;
  codexAppServerStatePath: string;
  codexAppServerLogPath: string;
  codexAuthDir: string | null;
  codexHome: string | null;
  codexApiProviders: CodexApiProviderConfig[];
  codexApiDefaultProvider: string | null;
  codexAppSyncOnOpen: boolean;
  codexAppSyncOnTurnComplete: boolean;
  storePath: string;
  logLevel: LogLevel;
  defaultCwd: string;
  defaultApprovalPolicy: ApprovalPolicyValue;
  defaultSandboxMode: SandboxModeValue;
  telegramPollIntervalMs: number;
  telegramPreviewThrottleMs: number;
  telegramDeleteToolDetailsAfterFinal: boolean;
  telegramPanelTtlMs: number;
  threadListLimit: number;
  statusPath: string;
  logPath: string;
  lockPath: string;
  envPath: string | null;
  /** When true, start Weixin (iLink) long-poll alongside Telegram. */
  wxEnabled: boolean;
  /** Allowed `from_user_id` values for inbound Weixin messages (empty = allow any). */
  wxAllowedIlinkUserIds: string[];
  weixinAccountsDir: string;
  weixinSyncBufDir: string;
  weixinMediaDir: string;
  /** Optional `SKRouteTag` header for some IDC deployments. */
  wxIlinkRouteTag: string | null;
  authSyncEnabled: boolean;
  authSyncTransport: 'telegram-private';
  authSyncKey: string | null;
  authSyncPeers: string[];
  authSyncNodeId: string | null;
  authSyncClusterId: string;
  authSyncStatePath: string;
  authSyncTempDir: string;
  authAutoDeleteNeedsRepair: boolean;
  voiceTtsEnabled: boolean;
  voiceTtsEngine: 'qwen' | 'soulx';
  voiceTtsMode: 'http' | 'ssh';
  voiceTtsUrl: string | null;
  voiceTtsToken: string | null;
  voiceTtsSshHost: string | null;
  voiceTtsSshDir: string | null;
  voiceTtsDesignInstruct: string;
  voiceFfmpegBin: string;
  voiceSummaryButtonEnabled: boolean;
  voiceSummaryTextLimit: number;
  voiceTextLimit: number;
  voiceTtsTimeoutMs: number;
}

export interface CodexApiProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string | null;
  wireApi: 'responses';
  sourceEndpoint: string | null;
  chatCompletionsOnly: boolean;
}

export function loadConfig(): AppConfig {
  loadEnv();
  const configuredTokens = parseCommaSeparatedIds(process.env.TG_BOT_TOKENS);
  const legacyToken = optional('TG_BOT_TOKEN');
  const tgDefaultRuntimeBotToken = selectDefaultRuntimeBotToken(configuredTokens, legacyToken);
  const tgBotTokens = configuredTokens.length > 0
    ? configuredTokens
    : legacyToken
      ? [legacyToken]
      : [];
  if (tgBotTokens.length === 0) {
    throw new Error('TG_BOT_TOKENS or TG_BOT_TOKEN is required');
  }
  const config: AppConfig = {
    tgBotToken: tgBotTokens[0]!,
    tgBotTokens,
    tgMultiBotMode: configuredTokens.length > 0,
    tgDefaultRuntimeBotToken,
    tgScopeBotId: null,
    tgRequireExplicitGroupAddressing: configuredTokens.length > 1,
    tgAllowedUserId: required('TG_ALLOWED_USER_ID'),
    tgAllowedChatId: optional('TG_ALLOWED_CHAT_ID'),
    tgAllowedTopicId: nullableIntEnv('TG_ALLOWED_TOPIC_ID'),
    codexCliBin: process.env.CODEX_CLI_BIN || resolveCommand('codex') || 'codex',
    codexAppAutolaunch: boolEnv('CODEX_APP_AUTOLAUNCH', true),
    codexAppLaunchCmd: process.env.CODEX_APP_LAUNCH_CMD || 'codex app',
    codexAppServerStatePath: process.env.CODEX_APP_SERVER_STATE_PATH || DEFAULT_CODEX_APP_SERVER_STATE_PATH,
    codexAppServerLogPath: process.env.CODEX_APP_SERVER_LOG_PATH || DEFAULT_CODEX_APP_SERVER_LOG_PATH,
    codexAuthDir: process.env.CODEX_AUTH_DIR?.trim() || null,
    codexHome: process.env.CODEX_HOME?.trim() || null,
    codexApiProviders: parseCodexApiProviders(process.env.CODEX_API_PROVIDERS),
    codexApiDefaultProvider: optionalSanitizedProviderId(process.env.CODEX_API_DEFAULT_PROVIDER),
    codexAppSyncOnOpen: boolEnv('CODEX_APP_SYNC_ON_OPEN', true),
    codexAppSyncOnTurnComplete: boolEnv('CODEX_APP_SYNC_ON_TURN_COMPLETE', false),
    storePath: process.env.STORE_PATH || DEFAULT_STORE_PATH,
    logLevel: parseLogLevel(process.env.LOG_LEVEL || 'info'),
    defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
    defaultApprovalPolicy: parseApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || 'on-request'),
    defaultSandboxMode: parseSandboxMode(process.env.DEFAULT_SANDBOX_MODE || 'workspace-write'),
    telegramPollIntervalMs: intEnv('TELEGRAM_POLL_INTERVAL_MS', 1200),
    telegramPreviewThrottleMs: intEnv('TELEGRAM_PREVIEW_THROTTLE_MS', 800),
    telegramDeleteToolDetailsAfterFinal: boolEnv('TELEGRAM_DELETE_TOOL_DETAILS_AFTER_FINAL', true),
    telegramPanelTtlMs: intEnv('TELEGRAM_PANEL_TTL_MS', 5 * 60_000),
    threadListLimit: intEnv('THREAD_LIST_LIMIT', 10),
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH,
    lockPath: process.env.LOCK_PATH || DEFAULT_LOCK_PATH,
    envPath: getLoadedEnvPath(),
    wxEnabled: boolEnv('WX_ENABLED', false),
    wxAllowedIlinkUserIds: parseCommaSeparatedIds(process.env.WX_ALLOWED_ILINK_USER_IDS),
    weixinAccountsDir: process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts'),
    weixinSyncBufDir: process.env.WEIXIN_SYNC_BUF_DIR || path.join(APP_HOME, 'weixin', 'sync-buf'),
    weixinMediaDir: process.env.WEIXIN_MEDIA_DIR || path.join(APP_HOME, 'weixin', 'media'),
    wxIlinkRouteTag: optional('WX_ILINK_ROUTE_TAG'),
    authSyncEnabled: boolEnv('AUTH_SYNC_ENABLED', false),
    authSyncTransport: 'telegram-private',
    authSyncKey: optional('AUTH_SYNC_KEY'),
    authSyncPeers: parseCommaSeparatedIds(process.env.AUTH_SYNC_PEERS),
    authSyncNodeId: optional('AUTH_SYNC_NODE_ID'),
    authSyncClusterId: process.env.AUTH_SYNC_CLUSTER_ID?.trim() || 'default',
    authSyncStatePath: process.env.AUTH_SYNC_STATE_PATH || DEFAULT_AUTH_SYNC_STATE_PATH,
    authSyncTempDir: process.env.AUTH_SYNC_TEMP_DIR || DEFAULT_AUTH_SYNC_TEMP_DIR,
    authAutoDeleteNeedsRepair: boolEnv('AUTH_AUTO_DELETE_NEEDS_REPAIR', false),
    voiceTtsEnabled: boolEnv('VOICE_TTS_ENABLED', false),
    voiceTtsEngine: parseVoiceTtsEngine(process.env.VOICE_TTS_ENGINE || 'qwen'),
    voiceTtsMode: parseVoiceTtsMode(process.env.VOICE_TTS_MODE || (process.env.VOICE_TTS_SSH_HOST?.trim() ? 'ssh' : 'http')),
    voiceTtsUrl: optional('VOICE_TTS_URL'),
    voiceTtsToken: optional('VOICE_TTS_TOKEN'),
    voiceTtsSshHost: optional('VOICE_TTS_SSH_HOST'),
    voiceTtsSshDir: optional('VOICE_TTS_SSH_DIR'),
    voiceTtsDesignInstruct: process.env.VOICE_TTS_DESIGN_INSTRUCT?.trim() || '用自然清晰的中文女声朗读，语速适中。',
    voiceFfmpegBin: process.env.VOICE_FFMPEG_BIN?.trim() || 'ffmpeg',
    voiceSummaryButtonEnabled: boolEnv('VOICE_SUMMARY_BUTTON_ENABLED', true),
    voiceSummaryTextLimit: intEnv('VOICE_SUMMARY_TEXT_LIMIT', 180),
    voiceTextLimit: intEnv('VOICE_TEXT_LIMIT', 2800),
    voiceTtsTimeoutMs: intEnv('VOICE_TTS_TIMEOUT_MS', 300_000),
  };
  ensureAppDirs(config);
  return config;
}

export function buildCodexApiProviderOverrides(
  providers: readonly CodexApiProviderConfig[],
  defaultProviderId: string | null = null,
): string[] {
  const overrides: string[] = [];
  for (const provider of providers) {
    overrides.push(`model_providers.${provider.id}=${tomlInlineTable({
      name: provider.name,
      base_url: provider.baseUrl,
      env_key: provider.apiKeyEnv,
      wire_api: provider.wireApi,
    })}`);
  }
  if (defaultProviderId) {
    const selected = providers.find(provider => provider.id === defaultProviderId);
    if (!selected) {
      throw new Error(`CODEX_API_DEFAULT_PROVIDER does not match any configured provider: ${defaultProviderId}`);
    }
    overrides.push(`model_provider=${tomlString(selected.id)}`);
    if (selected.model) {
      overrides.push(`model=${tomlString(selected.model)}`);
    }
  }
  return overrides;
}

export function parseCodexApiProviders(raw: string | undefined): CodexApiProviderConfig[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('CODEX_API_PROVIDERS JSON must be an array');
    }
    return parsed.map((entry, index) => normalizeCodexApiProvider(entry, index));
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split('|').map((part) => part.trim());
      if (parts.length < 3 || parts.length > 5) {
        throw new Error('CODEX_API_PROVIDERS entries must use id|url|env_key[|model][|name]');
      }
      const [id, url, apiKeyEnv, model, name] = parts as [string, string, string, string | undefined, string | undefined];
      return normalizeCodexApiProvider({ id, url, apiKeyEnv, model, displayName: name }, index);
    });
}

function normalizeCodexApiProvider(entry: unknown, index: number): CodexApiProviderConfig {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`CODEX_API_PROVIDERS[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const id = sanitizeCodexProviderId(stringField(record, ['id'], index));
  const sourceEndpoint = optionalStringField(record, ['endpoint', 'api', 'url', 'baseUrl', 'base_url']);
  if (!sourceEndpoint) {
    throw new Error(`CODEX_API_PROVIDERS[${index}] is missing url/baseUrl`);
  }
  const normalized = normalizeOpenAiCompatibleBaseUrl(sourceEndpoint);
  const apiKeyEnv = stringField(record, ['apiKeyEnv', 'api_key_env', 'envKey', 'env_key'], index);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`CODEX_API_PROVIDERS[${index}] env key is not a valid environment variable name`);
  }
  const displayName = optionalStringField(record, ['displayName', 'display_name', 'label']) ?? id;
  return {
    id,
    name: displayName,
    baseUrl: normalized.baseUrl,
    apiKeyEnv,
    model: optionalStringField(record, ['model']),
    wireApi: 'responses',
    sourceEndpoint,
    chatCompletionsOnly: normalized.chatCompletionsEndpoint,
  };
}

function normalizeOpenAiCompatibleBaseUrl(input: string): { baseUrl: string; chatCompletionsEndpoint: boolean } {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('CODEX_API_PROVIDERS contains an empty URL');
  }
  const chatSuffix = '/chat/completions';
  if (trimmed.endsWith(chatSuffix)) {
    return { baseUrl: trimmed.slice(0, -chatSuffix.length), chatCompletionsEndpoint: true };
  }
  return { baseUrl: trimmed, chatCompletionsEndpoint: false };
}

function stringField(record: Record<string, unknown>, keys: string[], index: number): string {
  const value = optionalStringField(record, keys);
  if (!value) {
    throw new Error(`CODEX_API_PROVIDERS[${index}] is missing ${keys[0]}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function sanitizeCodexProviderId(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized) {
    throw new Error('CODEX_API_PROVIDERS contains an invalid provider id');
  }
  return sanitized;
}

function optionalSanitizedProviderId(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return sanitizeCodexProviderId(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function selectDefaultRuntimeBotToken(configuredTokens: string[], legacyToken: string | null): string | null {
  if (configuredTokens.length === 0 || !legacyToken) return null;
  return configuredTokens.includes(legacyToken) ? legacyToken : null;
}

export function ensureAppDirs(config: AppConfig): void {
  const dirs = [
    path.dirname(config.storePath),
    path.dirname(config.statusPath),
    path.dirname(config.logPath),
    path.dirname(config.lockPath),
    path.dirname(config.codexAppServerStatePath),
    path.dirname(config.codexAppServerLogPath),
    path.dirname(config.authSyncStatePath),
  ];
  if (config.authSyncEnabled) {
    dirs.push(config.authSyncTempDir);
  }
  if (config.wxEnabled) {
    dirs.push(config.weixinAccountsDir, config.weixinSyncBufDir, config.weixinMediaDir);
  }
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseCommaSeparatedIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function required(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optional(key: string): string | null {
  const value = process.env[key];
  if (!value || !value.trim()) return null;
  return value.trim();
}

function intEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableIntEnv(key: string): number | null {
  const value = process.env[key];
  if (!value || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value !== 'false' && value !== '0';
}

function parseLogLevel(value: string): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function parseApprovalPolicy(value: string): AppConfig['defaultApprovalPolicy'] {
  if (value === 'on-failure' || value === 'never' || value === 'untrusted' || value === 'on-request') return value;
  return 'on-request';
}

function parseSandboxMode(value: string): AppConfig['defaultSandboxMode'] {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  return 'workspace-write';
}

function parseVoiceTtsMode(value: string): AppConfig['voiceTtsMode'] {
  return value.trim().toLowerCase() === 'http' ? 'http' : 'ssh';
}

function parseVoiceTtsEngine(value: string): AppConfig['voiceTtsEngine'] {
  return value.trim().toLowerCase() === 'soulx' ? 'soulx' : 'qwen';
}

function resolveCommand(commandName: string): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(which, [commandName], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    return String(result.stdout).trim().split(/\r?\n/, 1)[0] || null;
  } catch {
    return null;
  }
}
