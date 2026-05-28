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
  codexAppSyncOnOpen: boolean;
  codexAppSyncOnTurnComplete: boolean;
  storePath: string;
  logLevel: LogLevel;
  defaultCwd: string;
  defaultApprovalPolicy: ApprovalPolicyValue;
  defaultSandboxMode: SandboxModeValue;
  telegramPollIntervalMs: number;
  telegramPreviewThrottleMs: number;
  threadListLimit: number;
  statusPath: string;
  logPath: string;
  lockPath: string;
  /** When true, start Weixin (iLink) long-poll alongside Telegram. */
  wxEnabled: boolean;
  /** Allowed `from_user_id` values for inbound Weixin messages (empty = allow any). */
  wxAllowedIlinkUserIds: string[];
  weixinAccountsDir: string;
  weixinSyncBufDir: string;
  weixinMediaDir: string;
  /** Optional `SKRouteTag` header for some IDC deployments. */
  wxIlinkRouteTag: string | null;
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
    codexAppSyncOnOpen: boolEnv('CODEX_APP_SYNC_ON_OPEN', true),
    codexAppSyncOnTurnComplete: boolEnv('CODEX_APP_SYNC_ON_TURN_COMPLETE', false),
    storePath: process.env.STORE_PATH || DEFAULT_STORE_PATH,
    logLevel: parseLogLevel(process.env.LOG_LEVEL || 'info'),
    defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
    defaultApprovalPolicy: parseApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || 'on-request'),
    defaultSandboxMode: parseSandboxMode(process.env.DEFAULT_SANDBOX_MODE || 'workspace-write'),
    telegramPollIntervalMs: intEnv('TELEGRAM_POLL_INTERVAL_MS', 1200),
    telegramPreviewThrottleMs: intEnv('TELEGRAM_PREVIEW_THROTTLE_MS', 800),
    threadListLimit: intEnv('THREAD_LIST_LIMIT', 10),
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH,
    lockPath: process.env.LOCK_PATH || DEFAULT_LOCK_PATH,
    wxEnabled: boolEnv('WX_ENABLED', false),
    wxAllowedIlinkUserIds: parseCommaSeparatedIds(process.env.WX_ALLOWED_ILINK_USER_IDS),
    weixinAccountsDir: process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts'),
    weixinSyncBufDir: process.env.WEIXIN_SYNC_BUF_DIR || path.join(APP_HOME, 'weixin', 'sync-buf'),
    weixinMediaDir: process.env.WEIXIN_MEDIA_DIR || path.join(APP_HOME, 'weixin', 'media'),
    wxIlinkRouteTag: optional('WX_ILINK_ROUTE_TAG'),
  };
  ensureAppDirs(config);
  return config;
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
  ];
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
