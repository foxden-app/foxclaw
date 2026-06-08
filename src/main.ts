#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP_HOME,
  DEFAULT_CODEX_TELEGRAM_HOME,
  DEFAULT_ENV_PATH,
  DEFAULT_LOG_PATH,
  DEFAULT_STATUS_PATH,
  getLoadedEnvPath,
  loadConfig,
  loadEnv,
  type AppConfig,
} from './config.js';
import type { AuthSyncNotification } from './auth/cross_node_sync.js';
import type { AppLocale } from './types.js';
import { acquireProcessLock, LockHeldError } from './lock.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtime.js';
import { buildFoxclawSystemdUnitText, refreshFoxclawExecStartDropIns, removeFoxclawExecStartDropIns } from './systemd.js';
import {
  createSelfUpdateRuntime,
  inferPnpmHomeFromEntryPoint,
  performSelfUpdate,
  readSelfUpdateStatus,
  writeSelfUpdateStatus,
} from './update.js';

const rawCommand = process.argv[2];
const command = rawCommand || 'serve';
loadEnv();
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryPoint = fileURLToPath(import.meta.url);
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;
const STANDARD_NODE_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
const LOCAL_AUTH_REFRESH_LEASE_TTL_MS = 10 * 60_000;

type LocalAuthRefreshLeaseResult = { ok: boolean; leaseId: string | null; reason?: string | null };

function createLocalAuthRefreshLease(): {
  isIdle: () => boolean;
  acquire: (reason: string) => Promise<LocalAuthRefreshLeaseResult>;
  release: (leaseId: string | null) => Promise<void>;
} {
  let active: { leaseId: string; reason: string; expiresAt: number } | null = null;
  const expire = (): void => {
    if (active && active.expiresAt <= Date.now()) {
      active = null;
    }
  };
  return {
    isIdle: (): boolean => {
      expire();
      return active === null;
    },
    acquire: async (reason: string): Promise<LocalAuthRefreshLeaseResult> => {
      expire();
      if (active) {
        return {
          ok: false,
          leaseId: null,
          reason: `another local auth refresh lease is active: ${active.reason}`,
        };
      }
      const leaseId = crypto.randomUUID();
      active = { leaseId, reason, expiresAt: Date.now() + LOCAL_AUTH_REFRESH_LEASE_TTL_MS };
      return { ok: true, leaseId };
    },
    release: async (leaseId: string | null): Promise<void> => {
      if (leaseId && active?.leaseId === leaseId) {
        active = null;
      }
    },
  };
}

async function main(): Promise<void> {
  if (isVersionCommand(command)) {
    console.log(readPackageVersion());
    return;
  }

  if (isHelpCommand(command)) {
    printUsage();
    return;
  }

  if (command === 'init') {
    await initConfig();
    return;
  }

  if (command === 'install-systemd') {
    requireNode24(command);
    installSystemd();
    return;
  }

  if (command === 'start') {
    requireNode24(command);
    startService('start');
    return;
  }

  if (command === 'restart') {
    requireNode24(command);
    startService('restart');
    return;
  }

  if (command === 'update') {
    requireNode24(command);
    const notificationFile = readOptionValue('--notification-file');
    const options = {
      entryPoint,
      nodePath: process.execPath,
      version: readPackageVersion(),
      ...(process.env.CODEX_CLI_BIN || resolveCommand('codex')
        ? { codexCliBin: process.env.CODEX_CLI_BIN || resolveCommand('codex')! }
        : {}),
      ...(notificationFile ? { notificationFile } : {}),
    };
    const outcome = performSelfUpdate(options);
    process.exit(outcome.ok ? 0 : 1);
  }

  if (command === 'stop') {
    stopService();
    return;
  }

  if (command === 'uninstall-systemd') {
    uninstallSystemd();
    return;
  }

  if (command === 'install-launchd') {
    requireNode24(command);
    installLaunchd();
    return;
  }

  if (command === 'status') {
    const status = readRuntimeStatus(process.env.STATUS_PATH || DEFAULT_STATUS_PATH);
    if (!status) {
      console.log('No runtime status found.');
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === 'doctor') {
    const failed = !runDoctorChecks();
    process.exit(failed ? 1 : 0);
  }

  if (command === 'weixin-login') {
    requireNode24(command);
    await runWeixinLoginCli();
    return;
  }

  if (command !== 'serve') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  requireNode24(command);
  await runServeCli();
}

function isVersionCommand(value: string): boolean {
  return value === 'version' || value === '--version' || value === '-v' || value === '-V';
}

function isHelpCommand(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printUsage(): void {
  console.log(`FoxClaw ${readPackageVersion()}

Usage:
  foxclaw [serve]
  foxclaw init
  foxclaw doctor
  foxclaw status
  foxclaw start|restart|stop
  foxclaw update
  foxclaw install-systemd|uninstall-systemd
  foxclaw install-launchd
  foxclaw weixin-login [account-id]
  foxclaw --version
  foxclaw --help`);
}

async function runServeCli(): Promise<void> {
  const [
    { BridgeMessagingRouter },
    { TelegramMessagingPort },
    { WeixinChannelAdapter },
    { WeixinMessagingPort },
    { attachIlinkRuntimeFromBridgeLogger },
    { loadWeixinAccount },
    { Logger },
    { BridgeStore },
    { TelegramGateway },
    { CodexAppClient },
    { BridgeSessionCore },
    { TelegramChannelAdapter },
    { AuthCandidateMirror },
    { CrossNodeAuthSync },
  ] = await Promise.all([
    import('./channels/bridge_messaging_router.js'),
    import('./channels/telegram/telegram_messaging_port.js'),
    import('./channels/weixin/weixin_channel_adapter.js'),
    import('./channels/weixin/weixin_messaging_port.js'),
    import('./channels/weixin/ilink/runtime_attach.js'),
    import('./channels/weixin/account_store.js'),
    import('./logger.js'),
    import('./store/database.js'),
    import('./telegram/gateway.js'),
    import('./codex_app/client.js'),
    import('./controller/controller.js'),
    import('./channels/telegram/telegram_channel_adapter.js'),
    import('./auth/mirror.js'),
    import('./auth/cross_node_sync.js'),
  ]);
  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);
  attachIlinkRuntimeFromBridgeLogger(logger, config.wxIlinkRouteTag);
  const processLock = acquireProcessLock(config.lockPath);
  let store: InstanceType<typeof BridgeStore> | null = null;
  let weixinAdapter: InstanceType<typeof WeixinChannelAdapter> | null = null;
  let activeWeixinCore: InstanceType<typeof BridgeSessionCore> | null = null;
  let activeTelegramAdapters: Array<InstanceType<typeof TelegramChannelAdapter>> = [];
  let managedApps: Array<InstanceType<typeof CodexAppClient>> = [];
  let activeAuthMirror: InstanceType<typeof AuthCandidateMirror> | null = null;
  let activeAuthSync: InstanceType<typeof CrossNodeAuthSync> | null = null;
  try {
    store = new BridgeStore(config.storePath);
    if (config.tgMultiBotMode) {
      type RuntimeSeed = {
        id: string;
        home: string;
        authDir: string;
        sharedDefaultRuntime: boolean;
        config: typeof config;
        bot: InstanceType<typeof TelegramGateway>;
        app: InstanceType<typeof CodexAppClient>;
      };
      type Runtime = RuntimeSeed & {
        core: InstanceType<typeof BridgeSessionCore>;
        telegram: InstanceType<typeof TelegramChannelAdapter>;
      };
      const seeds: RuntimeSeed[] = [];
      const canonicalAuthDir = config.codexAuthDir ?? config.codexHome ?? path.join(os.homedir(), '.codex');
      for (const token of config.tgBotTokens) {
        const bot = new TelegramGateway(
          token,
          config.tgAllowedUserId,
          config.tgAllowedChatId,
          config.telegramPollIntervalMs,
          store,
          logger,
          true,
        );
        const id = await bot.initializeIdentity();
        if (seeds.some((runtime) => runtime.id === id)) {
          throw new Error(`TG_BOT_TOKENS contains duplicate Telegram bot identity: ${id}`);
        }
        const sharedDefaultRuntime = config.tgDefaultRuntimeBotToken === token;
        const home = sharedDefaultRuntime
          ? (config.codexHome ?? path.join(os.homedir(), '.codex'))
          : path.join(DEFAULT_CODEX_TELEGRAM_HOME, id, 'home');
        const authDir = sharedDefaultRuntime ? canonicalAuthDir : home;
        if (!sharedDefaultRuntime) {
          fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        }
        const runtimeConfig = {
          ...config,
          tgBotToken: token,
          tgBotTokens: [token],
          tgScopeBotId: id,
          codexAuthDir: sharedDefaultRuntime ? config.codexAuthDir : home,
          codexHome: sharedDefaultRuntime ? config.codexHome : home,
          codexAppAutolaunch: sharedDefaultRuntime ? config.codexAppAutolaunch : false,
          codexAppServerStatePath: sharedDefaultRuntime
            ? config.codexAppServerStatePath
            : path.join(APP_HOME, 'runtime', `codex-app-server-${id}.json`),
          codexAppServerLogPath: sharedDefaultRuntime
            ? config.codexAppServerLogPath
            : path.join(APP_HOME, 'logs', `codex-app-server-${id}.log`),
        };
        const childEnv = sharedDefaultRuntime
          ? (config.codexHome ? { CODEX_HOME: config.codexHome } : null)
          : { CODEX_HOME: home };
        const app = new CodexAppClient(
          runtimeConfig.codexCliBin,
          runtimeConfig.codexAppLaunchCmd,
          runtimeConfig.codexAppAutolaunch,
          runtimeConfig.codexAppServerStatePath,
          runtimeConfig.codexAppServerLogPath,
          logger,
          childEnv,
          sharedDefaultRuntime ? [] : ['cli_auth_credentials_store="file"'],
        );
        seeds.push({ id, home, authDir, sharedDefaultRuntime, config: runtimeConfig, bot, app });
      }

      let authSync: InstanceType<typeof CrossNodeAuthSync> | null = null;
      const mirror = new AuthCandidateMirror(
        canonicalAuthDir,
        seeds.map((runtime) => ({
          id: runtime.id,
          label: runtime.bot.username ? `@${runtime.bot.username}` : runtime.id,
          authDir: runtime.authDir,
          validate: async (context) => validateRefreshedAuthCandidate(runtime, context.candidateName),
          notify: async (message: string): Promise<void> => {
            const chatId = store!.getTelegramPrivateChatId(runtime.id);
            if (chatId) {
              await runtime.bot.sendMessage(chatId, message);
            }
          },
        })),
        logger,
        path.join(APP_HOME, 'runtime', 'auth-mirror.json'),
        {
          onSynced: async (event): Promise<void> => {
            await authSync?.publishCandidate(event.record.candidateName);
          },
        },
      );
      await mirror.initialize();
      activeAuthMirror = mirror;
      managedApps = seeds.map((runtime) => runtime.app);

      const selfUpdater = createSelfUpdateRuntime({
        entryPoint,
        nodePath: process.execPath,
        version: readPackageVersion(),
        statusPath: config.statusPath,
        logPath: path.join(APP_HOME, 'logs', 'update.log'),
        codexCliBin: config.codexCliBin,
      });
      const lastSelfUpdatePath = path.join(APP_HOME, 'runtime', 'last-self-update.json');
      let lastSelfUpdate = readSelfUpdateStatus(lastSelfUpdatePath);
      const runtimes: Runtime[] = [];
      const localAuthRefreshLease = createLocalAuthRefreshLease();
      const writeAggregateStatus = (running = true): void => {
        const statuses = runtimes.map((runtime) => runtime.core.getRuntimeStatus());
        const weixinStatus = activeWeixinCore?.getRuntimeStatus() ?? null;
        const first = statuses[0] ?? null;
        writeRuntimeStatus(config.statusPath, {
          running,
          connected: running
            && statuses.every((status) => status.connected)
            && (!weixinStatus || weixinStatus.connected),
          userAgent: first?.userAgent ?? null,
          ...(first?.codexAppServer ? { codexAppServer: first.codexAppServer } : {}),
          botUsername: first?.botUsername ?? null,
          currentBindings: store!.countBindings(),
          pendingApprovals: store!.countPendingApprovals(),
          pendingUserInputs: store!.countPendingUserInputs(),
          queuedTurns: store!.countQueuedTurnInputs(),
          activeTurns: statuses.reduce((sum, status) => sum + status.activeTurns, 0)
            + (weixinStatus?.activeTurns ?? 0),
          lastError: statuses.find((status) => status.lastError)?.lastError
            ?? weixinStatus?.lastError
            ?? null,
          updatedAt: new Date().toISOString(),
          channels: { telegram: running, weixin: running && config.wxEnabled },
          bots: runtimes.map((runtime, index) => ({
            id: runtime.id,
            username: statuses[index]?.botUsername ?? runtime.bot.username,
            connected: running && Boolean(statuses[index]?.connected),
            activeTurns: running ? (statuses[index]?.activeTurns ?? 0) : 0,
            runtimeKind: runtime.sharedDefaultRuntime ? 'default' as const : 'isolated' as const,
            ...(statuses[index]?.codexAppServer ? { codexAppServer: statuses[index].codexAppServer } : {}),
          })),
          ...(weixinStatus ? {
            weixinRuntime: {
              connected: running && weixinStatus.connected,
              activeTurns: running ? weixinStatus.activeTurns : 0,
              ...(weixinStatus.codexAppServer ? { codexAppServer: weixinStatus.codexAppServer } : {}),
            },
          } : {}),
          authMirror: mirror.getStatus(),
          authSync: authSync?.getStatus() ?? null,
          lastUpdate: lastSelfUpdate,
        });
      };
      const authSyncLocalIdle = (): boolean => runtimes.every((runtime) => runtime.core.isIdleForServiceUpdate())
          && (!activeWeixinCore || activeWeixinCore.isIdleForServiceUpdate())
          && mirror.isIdle();
      const coordinator = {
        canSelfUpdate: (): boolean => authSyncLocalIdle()
          && (authSync ? authSync.isIdle() : localAuthRefreshLease.isIdle()),
        authCandidateUpdated: (runtimeId: string, candidateName: string): Promise<void> =>
          mirror.syncRuntimeCandidate(runtimeId, candidateName).then(() => undefined),
        recoverAuthCandidate: async (runtimeId: string, candidateName: string, options: { crossNode?: boolean } = {}): Promise<boolean> => {
          const local = await mirror.recoverRuntimeCandidate(runtimeId, candidateName);
          if (local) return true;
          if (options.crossNode === false) return false;
          const current = await mirror.readRuntimeCandidate(runtimeId, candidateName)
            ?? await mirror.readNewestCandidate(candidateName);
          return await authSync?.requestRecovery(candidateName, {
            accountId: current?.accountId ?? null,
            lastRefreshMs: current?.lastRefreshMs ?? null,
          }) ?? false;
        },
        acquireAuthRefreshLease: (reason: string) => authSync?.acquireRefreshLease(reason)
          ?? localAuthRefreshLease.acquire(reason),
        releaseAuthRefreshLease: (leaseId: string | null) => authSync?.releaseRefreshLease(leaseId)
          ?? localAuthRefreshLease.release(leaseId),
        getAuthSyncStatus: () => authSync?.getStatus() ?? null,
        authSyncSafeAll: async () => {
          const local = await mirror.syncAllRuntimeCandidates();
          const remote = await authSync?.pushAll() ?? { sent: 0, skipped: 0 };
          return {
            localSynced: local.synced,
            localSkipped: local.skipped,
            sent: remote.sent,
            skipped: remote.skipped,
          };
        },
        authSyncPushAll: () => authSync?.pushAll() ?? Promise.resolve({ sent: 0, skipped: 0 }),
        authSyncTest: () => authSync?.testPeers() ?? Promise.resolve({ sent: 0, replied: 0, missing: [] }),
        statusUpdated: (): void => writeAggregateStatus(),
        getServiceStatus: async () => ({
          bots: await Promise.all(runtimes.map(async (runtime) => {
            const status = runtime.core.getRuntimeStatus();
            return {
              id: runtime.id,
              username: status.botUsername ?? runtime.bot.username,
              connected: status.connected,
              activeTurns: status.activeTurns,
              runtimeKind: runtime.sharedDefaultRuntime ? 'default' as const : 'isolated' as const,
              currentAuth: await runtime.core.getCurrentAuthLabel().catch(() => null),
              ...(status.codexAppServer ? { codexAppServer: status.codexAppServer } : {}),
            };
          })),
          ...(activeWeixinCore ? {
            weixinRuntime: {
              connected: activeWeixinCore.getRuntimeStatus().connected,
              activeTurns: activeWeixinCore.getRuntimeStatus().activeTurns,
              codexAppServer: activeWeixinCore.getRuntimeStatus().codexAppServer,
            },
          } : {}),
          authMirror: mirror.getStatus(),
          authSync: authSync?.getStatus() ?? null,
          lastUpdate: lastSelfUpdate,
        }),
        selfUpdateCompleted: (status: import('./update.js').SelfUpdateStatus): void => {
          lastSelfUpdate = status;
          writeSelfUpdateStatus(lastSelfUpdatePath, status);
          writeAggregateStatus();
        },
      };
      for (const seed of seeds) {
        const telegramMessaging = new TelegramMessagingPort(seed.bot);
        const outbound = new BridgeMessagingRouter(telegramMessaging, null);
        const core = new BridgeSessionCore(seed.config, store, logger, seed.bot, seed.app, outbound, selfUpdater, coordinator);
        runtimes.push({ ...seed, core, telegram: new TelegramChannelAdapter(core) });
      }
      if (config.wxEnabled) {
        const weixinApp = new CodexAppClient(
          config.codexCliBin,
          config.codexAppLaunchCmd,
          config.codexAppAutolaunch,
          config.codexAppServerStatePath,
          config.codexAppServerLogPath,
          logger,
        );
        const outbound = new BridgeMessagingRouter(
          new TelegramMessagingPort(seeds[0]!.bot),
          new WeixinMessagingPort(store, (id) => loadWeixinAccount(config.weixinAccountsDir, id)),
        );
        activeWeixinCore = new BridgeSessionCore(
          config,
          store,
          logger,
          seeds[0]!.bot,
          weixinApp,
          outbound,
          selfUpdater,
          coordinator,
          false,
        );
        managedApps.push(weixinApp);
        weixinAdapter = new WeixinChannelAdapter(activeWeixinCore, store, config, logger);
      }
      activeTelegramAdapters = runtimes.map((runtime) => runtime.telegram);

      if (config.authSyncEnabled) {
        const authSyncTransportBot = seeds[0]!;
        const authSyncTransportLabel = authSyncTransportBot.bot.username
          ? `@${authSyncTransportBot.bot.username}`
          : authSyncTransportBot.id;
        authSync = new CrossNodeAuthSync(
          buildAuthSyncConfig(config, authSyncTransportLabel),
          logger,
          {
            send: async (peer: string, envelope: string): Promise<void> => {
              await authSyncTransportBot.bot.sendDocument(
                peer,
                `foxclaw-auth-sync-${Date.now()}.json`,
                Buffer.from(envelope, 'utf8'),
                'FOXCLAW_AUTH_SYNC_V1',
              );
            },
          },
          {
            readLocalCandidate: (candidateName: string) => mirror.readNewestCandidate(candidateName),
            listLocalCandidates: () => mirror.listNewestCandidates(),
            validateCandidate: async (candidateName: string, raw: string, expectedAccountId: string) => {
              if (!authSyncLocalIdle()) {
                return { ok: false, reason: 'runtime is not idle' };
              }
              const runtime = runtimes.find((entry) => entry.core.isIdleForServiceUpdate()) ?? runtimes[0] ?? null;
              if (!runtime) {
                return { ok: false, reason: 'no validation runtime is available' };
              }
              return runtime.core.validateExternalCodexAuthCandidate(candidateName, raw, expectedAccountId);
            },
            importCandidate: (candidateName, raw, source) => mirror.importExternalCandidate(candidateName, raw, source),
            isIdle: authSyncLocalIdle,
            notify: createAuthSyncNotifier(store!, authSyncTransportBot.bot),
          },
        );
        await authSync.initialize();
        activeAuthSync = authSync;
        attachTelegramAuthSync(authSyncTransportBot.bot, authSync, config, logger);
        authSync.start();
      }
      mirror.start();

      process.on('unhandledRejection', (error) => {
        logger.error('process.unhandled_rejection', { error: serializeError(error) });
      });
      process.on('uncaughtException', (error) => {
        logger.error('process.uncaught_exception', { error: serializeError(error) });
      });

      for (const runtime of runtimes) {
        await runtime.telegram.start();
      }
      if (weixinAdapter) {
        await activeWeixinCore!.startCodexApp();
        await weixinAdapter.start();
      }
      writeAggregateStatus();
      logger.info('bridge.started', { bots: runtimes.map((runtime) => runtime.id) });

      const shutdown = async (signal: string): Promise<void> => {
        logger.info('bridge.shutting_down', { signal });
        authSync?.stop();
        mirror.stop();
        await weixinAdapter?.stop();
        await activeWeixinCore?.stop();
        await Promise.all(runtimes.map((runtime) => runtime.telegram.stop()));
        writeAggregateStatus(false);
        await Promise.all(managedApps.map((app) => app.stop({ terminateServer: true }).catch((error) => {
          logger.warn('codex.app-server.stop_failed', { error: serializeError(error) });
        })));
        store?.close();
        processLock.release();
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      return;
    }
    const bot = new TelegramGateway(
      config.tgBotToken,
      config.tgAllowedUserId,
      config.tgAllowedChatId,
      config.telegramPollIntervalMs,
      store,
      logger,
    );
    const app = new CodexAppClient(
      config.codexCliBin,
      config.codexAppLaunchCmd,
      config.codexAppAutolaunch,
      config.codexAppServerStatePath,
      config.codexAppServerLogPath,
      logger,
    );
    const telegramMessaging = new TelegramMessagingPort(bot);
    const weixinMessaging = config.wxEnabled
      ? new WeixinMessagingPort(store, (id) => loadWeixinAccount(config.weixinAccountsDir, id))
      : null;
    const outbound = new BridgeMessagingRouter(telegramMessaging, weixinMessaging);
    const selfUpdater = createSelfUpdateRuntime({
      entryPoint,
      nodePath: process.execPath,
      version: readPackageVersion(),
      statusPath: config.statusPath,
      logPath: path.join(APP_HOME, 'logs', 'update.log'),
      codexCliBin: config.codexCliBin,
    });
    let singleAuthSync: InstanceType<typeof CrossNodeAuthSync> | null = null;
    let singleMirror: InstanceType<typeof AuthCandidateMirror> | null = null;
    let core: InstanceType<typeof BridgeSessionCore> | null = null;
    const singleAuthDir = config.codexAuthDir ?? config.codexHome ?? process.env.CODEX_AUTH_DIR ?? path.join(os.homedir(), '.codex');
    const singleLocalAuthRefreshLease = createLocalAuthRefreshLease();
    const singleAuthSyncLocalIdle = (): boolean => Boolean(core?.isIdleForServiceUpdate())
      && (!singleMirror || singleMirror.isIdle());
    const singleCoordinator = config.authSyncEnabled ? {
      canSelfUpdate: (): boolean => singleAuthSyncLocalIdle()
        && (singleAuthSync ? singleAuthSync.isIdle() : singleLocalAuthRefreshLease.isIdle()),
      authCandidateUpdated: (runtimeId: string, candidateName: string): Promise<void> =>
        singleMirror?.syncRuntimeCandidate(runtimeId, candidateName).then(() => undefined) ?? Promise.resolve(),
      recoverAuthCandidate: async (runtimeId: string, candidateName: string, options: { crossNode?: boolean } = {}): Promise<boolean> => {
        const local = await singleMirror?.recoverRuntimeCandidate(runtimeId, candidateName) ?? null;
        if (local) return true;
        if (options.crossNode === false) return false;
        const current = await singleMirror?.readRuntimeCandidate(runtimeId, candidateName)
          ?? await singleMirror?.readNewestCandidate(candidateName)
          ?? null;
        return await singleAuthSync?.requestRecovery(candidateName, {
          accountId: current?.accountId ?? null,
          lastRefreshMs: current?.lastRefreshMs ?? null,
        }) ?? false;
      },
      acquireAuthRefreshLease: (reason: string) => singleAuthSync?.acquireRefreshLease(reason)
        ?? singleLocalAuthRefreshLease.acquire(reason),
      releaseAuthRefreshLease: (leaseId: string | null) => singleAuthSync?.releaseRefreshLease(leaseId)
        ?? singleLocalAuthRefreshLease.release(leaseId),
      getAuthSyncStatus: () => singleAuthSync?.getStatus() ?? null,
      authSyncSafeAll: async () => {
        const local = await singleMirror?.syncAllRuntimeCandidates() ?? { synced: 0, skipped: 0 };
        const remote = await singleAuthSync?.pushAll() ?? { sent: 0, skipped: 0 };
        return {
          localSynced: local.synced,
          localSkipped: local.skipped,
          sent: remote.sent,
          skipped: remote.skipped,
        };
      },
      authSyncPushAll: () => singleAuthSync?.pushAll() ?? Promise.resolve({ sent: 0, skipped: 0 }),
      authSyncTest: () => singleAuthSync?.testPeers() ?? Promise.resolve({ sent: 0, replied: 0, missing: [] }),
      statusUpdated: (status: import('./types.js').RuntimeStatus): void => {
        writeRuntimeStatus(config.statusPath, {
          ...status,
          authMirror: singleMirror?.getStatus() ?? null,
          authSync: singleAuthSync?.getStatus() ?? null,
        });
      },
    } : null;
    if (config.authSyncEnabled) {
      singleMirror = new AuthCandidateMirror(
        singleAuthDir,
        [{
          id: 'default',
          label: bot.username ? `@${bot.username}` : 'default',
          authDir: singleAuthDir,
          validate: async (context) => validateRefreshedAuthCandidate({
            id: 'default',
            authDir: singleAuthDir,
            app,
          }, context.candidateName),
        }],
        logger,
        path.join(APP_HOME, 'runtime', 'auth-mirror.json'),
        {
          onSynced: async (event): Promise<void> => {
            await singleAuthSync?.publishCandidate(event.record.candidateName);
          },
        },
      );
      await singleMirror.initialize();
      activeAuthMirror = singleMirror;
    }
    core = new BridgeSessionCore(config, store, logger, bot, app, outbound, selfUpdater, singleCoordinator);
    if (config.authSyncEnabled && singleMirror) {
      await bot.initializeIdentity();
      singleAuthSync = new CrossNodeAuthSync(
        buildAuthSyncConfig(config, bot.username ? `@${bot.username}` : 'default'),
        logger,
        {
          send: async (peer: string, envelope: string): Promise<void> => {
            await bot.sendDocument(
              peer,
              `foxclaw-auth-sync-${Date.now()}.json`,
              Buffer.from(envelope, 'utf8'),
              'FOXCLAW_AUTH_SYNC_V1',
            );
          },
        },
        {
          readLocalCandidate: (candidateName: string) => singleMirror!.readNewestCandidate(candidateName),
          listLocalCandidates: () => singleMirror!.listNewestCandidates(),
          validateCandidate: async (candidateName: string, raw: string, expectedAccountId: string) => {
            if (!singleAuthSyncLocalIdle()) {
              return { ok: false, reason: 'runtime is not idle' };
            }
            return core!.validateExternalCodexAuthCandidate(candidateName, raw, expectedAccountId);
          },
          importCandidate: (candidateName, raw, source) => singleMirror!.importExternalCandidate(candidateName, raw, source),
          isIdle: singleAuthSyncLocalIdle,
          notify: createAuthSyncNotifier(store!, bot),
        },
      );
      await singleAuthSync.initialize();
      activeAuthSync = singleAuthSync;
      attachTelegramAuthSync(bot, singleAuthSync, config, logger);
      singleAuthSync.start();
      singleMirror.start();
    }
    const telegram = new TelegramChannelAdapter(core);
    managedApps = [app];
    activeTelegramAdapters = [telegram];
    if (config.wxEnabled) {
      weixinAdapter = new WeixinChannelAdapter(core, store, config, logger);
    }

    process.on('unhandledRejection', (error) => {
      logger.error('process.unhandled_rejection', { error: serializeError(error) });
    });

    process.on('uncaughtException', (error) => {
      logger.error('process.uncaught_exception', { error: serializeError(error) });
    });

    await telegram.start();
    if (weixinAdapter) {
      await weixinAdapter.start();
    }
    logger.info('bridge.started', core.getRuntimeStatus());

    const shutdown = async (signal: string): Promise<void> => {
      logger.info('bridge.shutting_down', { signal });
      singleAuthSync?.stop();
      singleMirror?.stop();
      await weixinAdapter?.stop();
      await telegram.stop();
      writeRuntimeStatus(config.statusPath, {
        running: false,
        connected: false,
        userAgent: app.getUserAgent(),
        codexAppServer: app.getServerStatus(),
        botUsername: bot.username,
        currentBindings: 0,
        pendingApprovals: 0,
        pendingUserInputs: 0,
        queuedTurns: 0,
        activeTurns: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
        channels: { telegram: false, weixin: false },
      });
      await app.stop({ terminateServer: true }).catch((error) => {
        logger.warn('codex.app-server.stop_failed', { error: serializeError(error) });
      });
      store?.close();
      processLock.release();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    activeAuthSync?.stop();
    activeAuthMirror?.stop();
    await weixinAdapter?.stop().catch(() => {});
    await activeWeixinCore?.stop().catch(() => {});
    await Promise.allSettled(activeTelegramAdapters.map((adapter) => adapter.stop()));
    await Promise.allSettled(managedApps.map((app) => app.stop({ terminateServer: true })));
    store?.close();
    processLock.release();
    throw error;
  }
}

interface AuthSyncNotifyBot {
  identity: string | null;
  sendMessage(chatId: string, text: string): Promise<number>;
}

interface AuthSyncNotifyStore {
  getTelegramPrivateScope(botId: string): { scopeId: string; chatId: string } | null;
  getChatSettings(scopeId: string): { locale: AppLocale | null } | null;
}

function createAuthSyncNotifier(store: AuthSyncNotifyStore, bot: AuthSyncNotifyBot): (event: AuthSyncNotification) => Promise<void> {
  return async (event: AuthSyncNotification): Promise<void> => {
    if (!bot.identity) return;
    const privateScope = store.getTelegramPrivateScope(bot.identity);
    if (!privateScope) return;
    const locale = store.getChatSettings(privateScope.scopeId)?.locale ?? 'en';
    await bot.sendMessage(privateScope.chatId, formatAuthSyncNotification(locale, event));
  };
}

function formatAuthSyncNotification(locale: AppLocale, event: AuthSyncNotification): string {
  const peers = 'peers' in event ? formatPeerList(event.peers, locale) : '';
  if (locale === 'zh') {
    switch (event.kind) {
      case 'candidate_publish_started':
        return `本机 auth 已更新：${event.candidateName}\n处理：正在同步到跨节点 peer：${peers}`;
      case 'candidate_publish_completed':
        return `跨节点 auth 已发出：${event.candidateName}\nPeer：${peers}\n注意：这只代表发送成功，对端导入结果会在对端通知或 /auth sync status 中显示。`;
      case 'candidate_publish_failed':
        return `跨节点 auth 发送失败：${event.candidateName}\nPeer：${peers}\n原因：${event.reason}`;
      case 'push_all_started':
        return `开始手动推送全部 auth：候选 ${event.candidateCount} 个\nPeer：${peers}`;
      case 'push_all_completed':
        return `手动 auth 同步推送完成：已发送 ${event.sent}，已跳过 ${event.skipped}\nPeer：${peers}`;
      case 'push_all_failed':
        return `手动 auth 同步推送中断：已发送 ${event.sent}，已跳过 ${event.skipped}\nPeer：${peers}\n原因：${event.reason}`;
      case 'remote_bundle_received':
        return [
          `收到跨节点 auth：${event.candidateName}`,
          `来源：${formatSource(event.sourceLabel, event.sourceNodeId)}，peer ${event.peer}`,
          `处理：${event.queued ? `本机忙，已排队等待空闲后验证导入；当前待导入 ${event.queueLength}` : '本机空闲，正在验证 usage 后导入'}`,
        ].join('\n');
      case 'remote_import_imported':
        return `${event.mode === 'pull' ? '已拉取并导入跨节点 auth' : '已导入跨节点 auth'}：${event.candidateName}\n来源：${formatSource(event.sourceLabel, event.sourceNodeId)}\n处理：已写入本机 auth 镜像，并同步到同节点 bot home。`;
      case 'remote_import_skipped':
        return `${event.mode === 'pull' ? '跨节点拉取未改动本机文件' : '收到跨节点 auth 但未写盘'}：${event.candidateName}\n来源：${formatSource(event.sourceLabel, event.sourceNodeId)}\n原因：${event.reason}`;
      case 'remote_import_failed':
        return `${event.mode === 'pull' ? '跨节点拉取导入失败' : '跨节点 auth 导入失败'}：${event.candidateName}\n来源：${formatSource(event.sourceLabel, event.sourceNodeId)}\n原因：${event.reason}\n需要注意：如果其他候选也无法恢复，请人工介入重新登录或刷新这个 auth。`;
      case 'recovery_started':
        return `auth 恢复开始：${event.candidateName}\nRequest：${event.requestId}\n处理：同节点没有可用较新副本，正在向跨节点 peer 查询：${peers}，最长等待 ${event.timeoutMs}ms`;
      case 'recovery_peer_empty':
        return `auth 恢复收到 peer 回应但没有可用副本：${event.candidateName}\nPeer：${event.peer}\n原因：${event.reason}`;
      case 'recovery_peer_bundle_received':
        return `auth 恢复收到 peer 候选：${event.candidateName}\nPeer：${event.peer}，来源节点：${event.sourceNodeId}\n处理：正在验证 usage 后导入。`;
      case 'recovery_failed':
        return [
          `auth 恢复已穷尽：${event.candidateName}`,
          event.requestId ? `Request：${event.requestId}` : null,
          `已查询 peer：${peers}`,
          event.waitMs !== undefined ? `等待：${event.waitMs}ms` : null,
          formatPeerReachability(event.peerReachability, 'zh'),
          `原因：${event.reason}`,
          '请人工介入：使用 /auth add <name> 或设备登录重新生成可用 auth。',
        ].filter(Boolean).join('\n');
      case 'pull_request_received':
        return `收到 peer 的 auth 查询：${event.candidateName}\nPeer：${event.peer}，请求节点：${event.requesterNodeId}`;
      case 'pull_response_sent':
        return `已回应 peer 的 auth 查询：${event.candidateName}\nPeer：${event.peer}\n结果：${formatPullResponseResult(event.result, event.reason, locale)}`;
      case 'sync_error':
        return `auth sync 需要注意：\n${event.reason}`;
    }
  }
  switch (event.kind) {
    case 'candidate_publish_started':
      return `Local auth updated: ${event.candidateName}\nAction: syncing to cross-node peers: ${peers}`;
    case 'candidate_publish_completed':
      return `Cross-node auth sent: ${event.candidateName}\nPeers: ${peers}\nNote: this confirms send success only; peer import is reported on the receiving node.`;
    case 'candidate_publish_failed':
      return `Cross-node auth send failed: ${event.candidateName}\nPeers: ${peers}\nReason: ${event.reason}`;
    case 'push_all_started':
      return `Manual auth sync push started: ${event.candidateCount} candidates\nPeers: ${peers}`;
    case 'push_all_completed':
      return `Manual auth sync push complete: sent ${event.sent}, skipped ${event.skipped}\nPeers: ${peers}`;
    case 'push_all_failed':
      return `Manual auth sync push stopped: sent ${event.sent}, skipped ${event.skipped}\nPeers: ${peers}\nReason: ${event.reason}`;
    case 'remote_bundle_received':
      return [
        `Received cross-node auth: ${event.candidateName}`,
        `Source: ${formatSource(event.sourceLabel, event.sourceNodeId)}, peer ${event.peer}`,
        `Action: ${event.queued ? `queued until this node is idle; pending imports ${event.queueLength}` : 'validating usage before import'}`,
      ].join('\n');
    case 'remote_import_imported':
      return `${event.mode === 'pull' ? 'Pulled and imported cross-node auth' : 'Imported cross-node auth'}: ${event.candidateName}\nSource: ${formatSource(event.sourceLabel, event.sourceNodeId)}\nAction: written to the local auth mirror and same-node bot homes.`;
    case 'remote_import_skipped':
      return `${event.mode === 'pull' ? 'Cross-node pull did not change local files' : 'Received cross-node auth but did not write it'}: ${event.candidateName}\nSource: ${formatSource(event.sourceLabel, event.sourceNodeId)}\nReason: ${event.reason}`;
    case 'remote_import_failed':
      return `${event.mode === 'pull' ? 'Cross-node pull import failed' : 'Cross-node auth import failed'}: ${event.candidateName}\nSource: ${formatSource(event.sourceLabel, event.sourceNodeId)}\nReason: ${event.reason}\nAttention: if no other candidate can recover this account, run device login or refresh this auth manually.`;
    case 'recovery_started':
      return `Auth recovery started: ${event.candidateName}\nRequest: ${event.requestId}\nAction: no newer same-node copy was available; querying cross-node peers: ${peers}; timeout ${event.timeoutMs}ms`;
    case 'recovery_peer_empty':
      return `Auth recovery peer replied without usable auth: ${event.candidateName}\nPeer: ${event.peer}\nReason: ${event.reason}`;
    case 'recovery_peer_bundle_received':
      return `Auth recovery peer returned a candidate: ${event.candidateName}\nPeer: ${event.peer}, source node: ${event.sourceNodeId}\nAction: validating usage before import.`;
    case 'recovery_failed':
      return [
        `Auth recovery exhausted: ${event.candidateName}`,
        event.requestId ? `Request: ${event.requestId}` : null,
        `Peers checked: ${peers}`,
        event.waitMs !== undefined ? `Wait: ${event.waitMs}ms` : null,
        formatPeerReachability(event.peerReachability, 'en'),
        `Reason: ${event.reason}`,
        'Manual action: use /auth add <name> or device login to create a usable auth.',
      ].filter(Boolean).join('\n');
    case 'pull_request_received':
      return `Received peer auth recovery request: ${event.candidateName}\nPeer: ${event.peer}, requester node: ${event.requesterNodeId}`;
    case 'pull_response_sent':
      return `Replied to peer auth recovery request: ${event.candidateName}\nPeer: ${event.peer}\nResult: ${formatPullResponseResult(event.result, event.reason, locale)}`;
    case 'sync_error':
      return `Auth sync needs attention:\n${event.reason}`;
  }
}

function formatPeerList(peers: string[], locale: AppLocale): string {
  return peers.length > 0 ? peers.join(', ') : (locale === 'zh' ? '无' : 'none');
}

function formatPeerReachability(
  reachability: Array<{ peer: string; reachableDuringRequest: boolean; lastReceivedAt: string | null }> | undefined,
  locale: AppLocale,
): string | null {
  const reachable = (reachability ?? []).filter((entry) => entry.reachableDuringRequest);
  if (reachable.length === 0) return null;
  const details = reachable
    .map((entry) => `${entry.peer}${entry.lastReceivedAt ? ` @ ${entry.lastReceivedAt}` : ''}`)
    .join(', ');
  return locale === 'zh'
    ? `注意：这些 peer 在本次等待期间有其他 auth sync 消息，说明 peer 可达但这个请求超时：${details}`
    : `Note: these peers sent other auth sync messages during this wait, so the peer was reachable but this request timed out: ${details}`;
}

function formatSource(sourceLabel: string, sourceNodeId: string): string {
  return sourceLabel === sourceNodeId ? sourceNodeId : `${sourceLabel} / ${sourceNodeId}`;
}

function formatPullResponseResult(result: AuthSyncPullResultAlias, reason: string | null, locale: AppLocale): string {
  const suffix = reason ? ` (${reason})` : '';
  if (locale === 'zh') {
    switch (result) {
      case 'sent':
        return `已返回较新候选${suffix}`;
      case 'candidate_not_found':
        return `本机没有这个候选${suffix}`;
      case 'account_mismatch':
        return `账号不匹配，未返回${suffix}`;
      case 'not_newer':
        return `本机副本不更新，未返回${suffix}`;
    }
  }
  switch (result) {
    case 'sent':
      return `sent newer candidate${suffix}`;
    case 'candidate_not_found':
      return `candidate not found${suffix}`;
    case 'account_mismatch':
      return `account mismatch; nothing sent${suffix}`;
    case 'not_newer':
      return `local copy is not newer; nothing sent${suffix}`;
  }
}

type AuthSyncPullResultAlias = Extract<AuthSyncNotification, { kind: 'pull_response_sent' }>['result'];

interface AuthSyncTelegramPeerDocumentEvent {
  userId: string;
  username: string | null;
  messageId: number;
  text: string;
  attachment: {
    fileId: string;
    fileName: string | null;
  };
}

interface AuthSyncTelegramBot {
  on(event: 'peerDocument', listener: (event: AuthSyncTelegramPeerDocumentEvent) => void): unknown;
  getFile(fileId: string): Promise<{ file_path?: string }>;
  downloadResolvedFile(remoteFilePath: string, destinationPath: string): Promise<number>;
}

interface AuthSyncHandler {
  handleIncomingEnvelope(rawEnvelope: string, peer: { userId: string; username: string | null }): Promise<boolean>;
}

interface AuthSyncLogger {
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
}

const AUTH_SYNC_TELEGRAM_CAPTION = 'FOXCLAW_AUTH_SYNC_V1';

function buildAuthSyncConfig(config: AppConfig, transportLabel: string | null = null) {
  return {
    enabled: config.authSyncEnabled,
    transport: config.authSyncTransport,
    transportLabel,
    key: config.authSyncKey,
    peers: config.authSyncPeers,
    nodeId: config.authSyncNodeId,
    clusterId: config.authSyncClusterId,
    statePath: config.authSyncStatePath,
    tempDir: config.authSyncTempDir,
  };
}

function attachTelegramAuthSync(
  bot: AuthSyncTelegramBot,
  sync: AuthSyncHandler,
  config: AppConfig,
  logger: AuthSyncLogger,
): void {
  bot.on('peerDocument', (event) => {
    void handleTelegramAuthSyncDocument(bot, sync, config, logger, event).catch((error) => {
      logger.warn('auth.sync.telegram_document_failed', { error: serializeError(error) });
    });
  });
}

async function handleTelegramAuthSyncDocument(
  bot: AuthSyncTelegramBot,
  sync: AuthSyncHandler,
  config: AppConfig,
  logger: AuthSyncLogger,
  event: AuthSyncTelegramPeerDocumentEvent,
): Promise<void> {
  const fileName = event.attachment.fileName ?? '';
  if (event.text.trim() !== AUTH_SYNC_TELEGRAM_CAPTION && !fileName.startsWith('foxclaw-auth-sync-')) {
    return;
  }
  const remoteFile = await bot.getFile(event.attachment.fileId);
  if (!remoteFile.file_path) {
    throw new Error('Telegram did not return file_path for auth sync document');
  }
  await fs.promises.mkdir(config.authSyncTempDir, { recursive: true, mode: 0o700 });
  const destination = path.join(config.authSyncTempDir, `inbound-${process.pid}-${Date.now()}-${event.messageId}.json`);
  try {
    await bot.downloadResolvedFile(remoteFile.file_path, destination);
    const raw = await fs.promises.readFile(destination, 'utf8');
    const handled = await sync.handleIncomingEnvelope(raw, {
      userId: event.userId,
      username: event.username,
    });
    if (handled) {
      logger.info('auth.sync.telegram_document_handled', {
        peer: event.username ? `@${event.username}` : event.userId,
      });
    }
  } finally {
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
  }
}

async function validateRefreshedAuthCandidate(
  runtime: { id: string; authDir: string; app: { isConnected(): boolean; readAccountRateLimits(): Promise<unknown> } },
  candidateName: string,
): Promise<{ ok: boolean; reason?: string }> {
  const authPath = path.join(runtime.authDir, 'auth.json');
  const candidatePath = path.join(runtime.authDir, candidateName);
  const [currentTarget, candidateTarget] = await Promise.all([
    fs.promises.realpath(authPath).catch(() => null),
    fs.promises.realpath(candidatePath).catch(() => null),
  ]);
  if (!currentTarget || !candidateTarget || currentTarget !== candidateTarget) {
    return { ok: false, reason: 'candidate is not the current auth target' };
  }
  if (!runtime.app.isConnected()) {
    return { ok: false, reason: 'source app-server is not connected' };
  }
  const rateLimits = await runtime.app.readAccountRateLimits();
  if (!rateLimits) {
    return { ok: false, reason: 'source app-server did not return ChatGPT rate limits' };
  }
  return { ok: true };
}

async function initConfig(): Promise<void> {
  const envPath = process.env.FOXCLAW_ENV?.trim() || DEFAULT_ENV_PATH;
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const existed = fs.existsSync(envPath);
  if (existed) {
    console.log(`Config already exists: ${envPath}`);
  } else {
    const examplePath = path.join(packageRoot, '.env.example');
    fs.copyFileSync(examplePath, envPath);
    console.log(`Created ${envPath}`);
  }

  if (!canPromptForInit()) {
    printProxyEnvHint(envPath);
    console.log(`Edit it manually, then run: foxclaw doctor`);
    return;
  }

  await configureEnvInteractively(envPath, existed);
}

function canPromptForInit(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.argv.includes('--no-input') && !process.argv.includes('--skip-prompts'));
}

async function configureEnvInteractively(envPath: string, existed: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (existed) {
      const updateExisting = (await rl.question('Update Telegram/workspace setup fields now? [y/N]: ')).trim().toLowerCase();
      if (updateExisting !== 'y' && updateExisting !== 'yes') {
        await maybeSaveProxyEnvFromShell(rl, envPath);
        console.log(`Edit it manually, then run: foxclaw doctor`);
        return;
      }
    } else {
      console.log('Interactive setup. Press Enter to skip any field and edit it later.');
    }

    const updates: Record<string, string> = {};
    const skipped: string[] = [];
    const warnings: string[] = [];

    Object.assign(updates, await maybeSaveProxyEnvFromShell(rl, envPath));

    const tokens = sanitizeEnvInput(await rl.question('Telegram bot token(s), comma-separated (TG_BOT_TOKENS): '));
    if (tokens) {
      updates.TG_BOT_TOKENS = tokens;
      if (tokens.split(',').map((token) => token.trim()).some((token) => !/^\d+:[A-Za-z0-9_-]+$/.test(token))) {
        warnings.push('One or more TG_BOT_TOKENS values do not look like standard Telegram bot tokens.');
      }
    } else {
      skipped.push('TG_BOT_TOKENS');
    }

    const userId = sanitizeEnvInput(await rl.question('Telegram numeric user ID (TG_ALLOWED_USER_ID): '));
    if (userId) {
      if (/^\d+$/.test(userId)) {
        updates.TG_ALLOWED_USER_ID = userId;
      } else {
        skipped.push('TG_ALLOWED_USER_ID');
        warnings.push('TG_ALLOWED_USER_ID must be numeric; use the Id from @userinfobot, not @username.');
      }
    } else {
      skipped.push('TG_ALLOWED_USER_ID');
    }

    const cwdDefault = defaultInitCwd();
    const cwdPrompt = cwdDefault
      ? `Default Codex workspace (DEFAULT_CWD) [${cwdDefault}]: `
      : 'Default Codex workspace (DEFAULT_CWD): ';
    const cwdAnswer = sanitizeEnvInput(await rl.question(cwdPrompt));
    const cwd = cwdAnswer ? normalizeUserPath(cwdAnswer) : cwdDefault;
    if (cwd) {
      updates.DEFAULT_CWD = cwd;
      warnings.push(...validateDefaultCwd(cwd));
    } else {
      skipped.push('DEFAULT_CWD');
    }

    const codexBin = resolveCommand('codex');
    if (codexBin) {
      updates.CODEX_CLI_BIN = codexBin;
    }

    const updatedKeys = Object.keys(updates);
    if (updatedKeys.length > 0) {
      writeEnvUpdates(envPath, updates);
      console.log(`Saved ${updatedKeys.join(', ')} to ${envPath}`);
    } else {
      console.log('No setup fields changed.');
    }

    for (const warning of warnings) {
      console.log(`[WARN] ${warning}`);
    }
    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.join(', ')}. Edit later: ${editorCommand(envPath)}`);
    }
    console.log('Next: foxclaw doctor');
  } finally {
    rl.close();
  }
}

function sanitizeEnvInput(value: string): string {
  return value.replace(/[\r\n]/g, '').trim();
}

function defaultInitCwd(): string | null {
  const cwd = path.resolve(process.cwd());
  if (isUnsafeDefaultCwd(cwd)) return null;
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    return null;
  }
  return null;
}

function normalizeUserPath(value: string): string {
  const expanded = value === '~' || value.startsWith('~/')
    ? path.join(process.env.HOME || '', value.slice(2))
    : value;
  return path.resolve(expanded);
}

function validateDefaultCwd(cwd: string): string[] {
  const warnings: string[] = [];
  if (!path.isAbsolute(cwd)) {
    warnings.push('DEFAULT_CWD should be an absolute path.');
  }
  if (isUnsafeDefaultCwd(cwd)) {
    warnings.push('DEFAULT_CWD points at a very broad directory; use a project/workspace folder for the first install.');
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      warnings.push('DEFAULT_CWD exists but is not a directory.');
    }
  } catch {
    warnings.push('DEFAULT_CWD does not exist yet; create it or edit the path before starting.');
  }
  return warnings;
}

function isUnsafeDefaultCwd(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
  return resolved === path.parse(resolved).root || resolved === home || resolved === '/home' || resolved === '/Users';
}

function writeEnvUpdates(envPath: string, updates: Record<string, string>): void {
  let text = fs.readFileSync(envPath, 'utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${formatEnvValue(value)}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
    if (pattern.test(text)) {
      text = text.replace(pattern, line);
    } else {
      if (text && !text.endsWith('\n') && !text.endsWith('\r\n')) {
        text += newline;
      }
      text += `${line}${newline}`;
    }
  }
  fs.writeFileSync(envPath, text);
}

async function maybeSaveProxyEnvFromShell(
  rl: ReturnType<typeof createInterface>,
  envPath: string,
): Promise<Record<string, string>> {
  const proxyUpdates = detectMissingProxyEnv(envPath);
  const keys = Object.keys(proxyUpdates);
  if (keys.length === 0) {
    return {};
  }
  console.log(`Detected proxy env in this shell: ${keys.join(', ')}`);
  const answer = (await rl.question('Save these proxy settings to FoxClaw .env for service use? [Y/n]: ')).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    console.log(`Skipped proxy env. Add it to ${envPath} if ChatGPT access needs a proxy.`);
    return {};
  }
  writeEnvUpdates(envPath, proxyUpdates);
  console.log(`Saved ${keys.join(', ')} to ${envPath}`);
  return proxyUpdates;
}

function printProxyEnvHint(envPath: string): void {
  const proxyUpdates = detectMissingProxyEnv(envPath);
  const keys = Object.keys(proxyUpdates);
  if (keys.length === 0) {
    return;
  }
  console.log(`[WARN] Proxy env detected in this shell but missing from ${envPath}: ${keys.join(', ')}`);
  console.log(`[WARN] Add those proxy variables to ${envPath} if ChatGPT/Codex needs a proxy.`);
}

function detectMissingProxyEnv(envPath: string): Record<string, string> {
  const existing = readEnvFileKeys(envPath);
  const existingCanonical = new Set(Array.from(existing, canonicalProxyEnvKey));
  const updates: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (!value || existing.has(key) || existingCanonical.has(canonicalProxyEnvKey(key))) {
      continue;
    }
    updates[key] = value;
  }
  return updates;
}

function canonicalProxyEnvKey(key: string): string {
  return key.toUpperCase();
}

function readEnvFileKeys(envPath: string): Set<string> {
  const keys = new Set<string>();
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return keys;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function formatEnvValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, '').trim();
  if (!/[\s#"\\]/.test(cleaned)) return cleaned;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function editorCommand(envPath: string): string {
  return `${process.env.EDITOR?.trim() || '$EDITOR'} ${envPath}`;
}

function readOptionValue(option: string): string | undefined {
  const index = process.argv.indexOf(option);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function startService(action: 'start' | 'restart'): void {
  if (!runDoctorChecks()) {
    console.error('');
    console.error(`Fix the failed checks above, then run: foxclaw ${action}`);
    process.exit(1);
  }
  if (process.platform === 'darwin') {
    installLaunchd();
    return;
  }
  installSystemd();
}

function stopService(): void {
  if (process.platform === 'darwin') {
    stopLaunchd();
    return;
  }
  stopSystemd();
}

function runDoctorChecks(): boolean {
  const configuredCodexBin = process.env.CODEX_CLI_BIN;
  const checks: Array<[string, boolean]> = [
    ['node >= 24', Number(process.versions.node.split('.')[0]) >= 24],
    ['codex cli available', hasConfiguredCodexBin(configuredCodexBin) || hasCommand('codex')],
    ['telegram bot token(s) configured', Boolean(process.env.TG_BOT_TOKENS?.trim() || process.env.TG_BOT_TOKEN?.trim())],
    ['telegram allowed user configured', Boolean(process.env.TG_ALLOWED_USER_ID)],
  ];
  if (process.env.WX_ENABLED === 'true' || process.env.WX_ENABLED === '1') {
    const accountsDir = process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts');
    let hasAccounts = false;
    try {
      if (fs.existsSync(accountsDir)) {
        hasAccounts = fs.readdirSync(accountsDir).some((n) => n.endsWith('.json'));
      }
    } catch {
      hasAccounts = false;
    }
    checks.push(['WX_ENABLED: Weixin account JSON present', hasAccounts]);
    checks.push(['WX_ALLOWED_ILINK_USER_IDS set (recommended)', Boolean(process.env.WX_ALLOWED_ILINK_USER_IDS?.trim())]);
  }
  let passed = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}`);
    if (!ok) passed = false;
  }
  try {
    const cwd = process.env.DEFAULT_CWD || process.cwd();
    fs.accessSync(cwd);
    console.log(`[OK] default cwd exists: ${cwd}`);
  } catch {
    const cwd = process.env.DEFAULT_CWD || process.cwd();
    console.log(`[FAIL] default cwd missing: ${cwd}`);
    passed = false;
  }
  warnIfProxyEnvMissingFromLoadedEnv();
  warnIfProxyConfigNeedsAttention();
  warnIfInstalledServiceNodeLooksWrong();
  warnIfSystemdUserLingerDisabled();
  return passed;
}

function warnIfProxyConfigNeedsAttention(): void {
  const proxychainsConf = process.env.FOXCLAW_PROXYCHAINS_CONF?.trim() || '';
  if (proxychainsConf) {
    if (process.platform !== 'linux') {
      console.log('[WARN] FOXCLAW_PROXYCHAINS_CONF is only used by systemd on Linux.');
    } else if (!fs.existsSync(proxychainsConf)) {
      console.log(`[WARN] FOXCLAW_PROXYCHAINS_CONF does not exist: ${proxychainsConf}`);
    } else if (!hasCommand('proxychains4')) {
      console.log('[WARN] proxychains4 is not available, but FOXCLAW_PROXYCHAINS_CONF is set.');
    } else {
      console.log(`[OK] proxychains config exists: ${proxychainsConf}`);
    }
    return;
  }

  const proxyKeys = PROXY_ENV_KEYS.filter((key) => proxyEnvValue(key));
  if (proxyKeys.length === 0) {
    return;
  }
  if (hasStandardNodeProxyEnv()) {
    console.log(`[OK] service proxy env configured: ${proxyKeys.join(', ')}`);
    return;
  }
  console.log('[WARN] Only ALL_PROXY/all_proxy is configured. Node service proxying works best with HTTP_PROXY/HTTPS_PROXY.');
  console.log('[WARN] For SOCKS-only hosts, set FOXCLAW_PROXYCHAINS_CONF=/absolute/path/to/proxychains.conf and run foxclaw restart.');
}

function warnIfProxyEnvMissingFromLoadedEnv(): void {
  const envPath = serviceEnvPath();
  const proxyUpdates = detectMissingProxyEnv(envPath);
  const keys = Object.keys(proxyUpdates);
  if (keys.length === 0) {
    return;
  }
  console.log(`[WARN] proxy env is present in this shell but missing from ${envPath}: ${keys.join(', ')}`);
  console.log(`[WARN] systemd/launchd services do not inherit your shell; add those variables to the FoxClaw env file if Codex needs a proxy.`);
}

function warnIfInstalledServiceNodeLooksWrong(): void {
  if (process.platform !== 'linux') {
    return;
  }
  const unitPath = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user', 'foxclaw.service');
  let text = '';
  try {
    text = fs.readFileSync(unitPath, 'utf8');
  } catch {
    return;
  }
  const execStart = text.match(/^ExecStart=(.+)$/m)?.[1]?.trim();
  const nodePath = execStart ? extractNodePathFromExecStart(execStart) : '';
  if (!nodePath) {
    return;
  }
  if (!fs.existsSync(nodePath)) {
    console.log(`[WARN] installed service node is missing: ${nodePath}`);
    console.log('[WARN] Run foxclaw start from a Node 24 shell to refresh the service unit.');
    return;
  }
  const result = spawnSync(nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  const version = result.status === 0 ? result.stdout.trim() : '';
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major >= 24) {
    console.log(`[OK] service node >= 24: ${nodePath}`);
    return;
  }
  console.log(`[WARN] installed service node is older than 24: ${nodePath}${version ? ` (${version})` : ''}`);
  console.log('[WARN] Run foxclaw start from a Node 24 shell to refresh the service unit.');
}

function warnIfSystemdUserLingerDisabled(): void {
  if (process.platform !== 'linux' || !hasCommand('loginctl')) {
    return;
  }
  const user = currentServiceUser();
  const linger = readSystemdUserLinger(user);
  if (linger === 'enabled') {
    console.log(`[OK] systemd user linger enabled: ${user}`);
    return;
  }
  if (linger === 'disabled') {
    console.log(`[WARN] systemd user linger is disabled for ${user}; user services may stop after logout.`);
    console.log('[WARN] Run foxclaw start to let FoxClaw enable it, or run: sudo loginctl enable-linger "$USER"');
  }
}

function extractNodePathFromExecStart(execStart: string): string {
  const tokens = execStart.split(/\s+/).map(systemdUnescape).filter(Boolean);
  const directNode = tokens[0] || '';
  if (path.basename(directNode) === 'node') {
    return directNode;
  }
  return tokens.find((token) => path.basename(token) === 'node') || directNode;
}

function installSystemd(): void {
  if (!hasCommand('systemctl')) {
    console.error('systemctl not found (need systemd)');
    process.exit(1);
  }
  const unitName = 'foxclaw.service';
  const userSystemdDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const unitPath = path.join(userSystemdDir, unitName);
  const envPath = serviceEnvPath();
  const configDir = path.dirname(envPath);
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const pathValue = buildServicePath(nodeDir);
  const proxychainsConf = process.env.FOXCLAW_PROXYCHAINS_CONF?.trim() || '';
  const proxychainsBin = proxychainsConf ? resolveCommand('proxychains4') || '/usr/bin/proxychains4' : '';
  const nodeProxyArgs = !proxychainsConf && hasStandardNodeProxyEnv() ? ' --use-env-proxy' : '';
  const execStart = proxychainsConf
    ? `${systemdEscape(proxychainsBin)} -f ${systemdEscape(proxychainsConf)} ${systemdEscape(nodeBin)} ${systemdEscape(entryPoint)} serve`
    : `${systemdEscape(nodeBin)}${nodeProxyArgs} ${systemdEscape(entryPoint)} serve`;
  fs.mkdirSync(userSystemdDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(APP_HOME, 'logs'), { recursive: true });
  const escapedEntryPoint = systemdEscape(entryPoint);
  fs.writeFileSync(unitPath, buildFoxclawSystemdUnitText({
    workingDirectory: systemdEscape(configDir),
    envPath: systemdEscape(envPath),
    home: systemdEscape(process.env.HOME || ''),
    user: systemdEscape(process.env.USER || ''),
    logname: systemdEscape(process.env.LOGNAME || process.env.USER || ''),
    pathValue: systemdEscape(pathValue),
    execStart,
  }));
  if (proxychainsConf) {
    console.log(`[OK] systemd proxychains enabled: ${proxychainsConf}`);
  } else if (nodeProxyArgs) {
    console.log('[OK] systemd Node env proxy enabled');
  }
  if (proxychainsConf) {
    const dropInUpdates = removeFoxclawExecStartDropIns(userSystemdDir, unitName);
    for (const update of dropInUpdates) {
      console.log(`[OK] removed stale FoxClaw ExecStart override: ${update.path}`);
    }
  } else {
    const dropInUpdates = refreshFoxclawExecStartDropIns(userSystemdDir, unitName, escapedEntryPoint);
    for (const update of dropInUpdates) {
      console.log(`[OK] updated FoxClaw ExecStart override: ${update.path}`);
    }
  }
  ensureSystemdUserLingerEnabled();
  spawnChecked('systemctl', ['--user', 'daemon-reload']);
  spawnChecked('systemctl', ['--user', 'enable', unitName]);
  const restarted = spawnSync('systemctl', ['--user', 'restart', unitName], { stdio: 'inherit' });
  if (restarted.status !== 0) {
    spawnChecked('systemctl', ['--user', 'start', unitName]);
  }
  console.log(`Installed ${unitPath}`);
  console.log(`Status: systemctl --user status ${unitName}`);
  console.log(`Logs:   journalctl --user -u ${unitName} -f`);
}

function ensureSystemdUserLingerEnabled(): void {
  if (process.platform !== 'linux') {
    return;
  }
  if (!hasCommand('loginctl')) {
    console.log('[WARN] loginctl not found; cannot enable systemd user linger automatically.');
    return;
  }
  const user = currentServiceUser();
  const before = readSystemdUserLinger(user);
  if (before === 'enabled') {
    console.log(`[OK] systemd user linger enabled: ${user}`);
    return;
  }
  console.log(`[INFO] Enabling systemd user linger for ${user} so FoxClaw keeps running after logout.`);
  let result = spawnSync('loginctl', ['enable-linger', user], { stdio: 'inherit' });
  if (result.status !== 0 && hasCommand('sudo')) {
    result = spawnSync('sudo', ['-n', 'loginctl', 'enable-linger', user], { stdio: 'inherit' });
  }
  if (result.status === 0 && readSystemdUserLinger(user) === 'enabled') {
    console.log(`[OK] systemd user linger enabled: ${user}`);
    return;
  }
  console.log(`[WARN] Could not enable systemd user linger automatically for ${user}.`);
  console.log(`[WARN] FoxClaw is installed, but it may stop after logout until you run: sudo loginctl enable-linger ${shellQuote(user)}`);
}

function uninstallSystemd(): void {
  if (!hasCommand('systemctl')) {
    console.error('systemctl not found');
    process.exit(1);
  }
  const unitName = 'foxclaw.service';
  const userSystemdDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const unitPath = path.join(userSystemdDir, unitName);
  spawnSync('systemctl', ['--user', 'disable', '--now', unitName], { stdio: 'inherit' });
  fs.rmSync(unitPath, { force: true });
  spawnChecked('systemctl', ['--user', 'daemon-reload']);
  console.log(`Removed ${unitPath}`);
}

function stopSystemd(): void {
  if (!hasCommand('systemctl')) {
    console.error('systemctl not found');
    process.exit(1);
  }
  const unitName = 'foxclaw.service';
  spawnChecked('systemctl', ['--user', 'stop', unitName]);
  console.log(`Stopped ${unitName}`);
}

function installLaunchd(): void {
  if (process.platform !== 'darwin') {
    console.error('launchd install is only available on macOS');
    process.exit(1);
  }
  const home = process.env.HOME || '';
  const plist = path.join(home, 'Library', 'LaunchAgents', 'app.foxden.foxclaw.plist');
  const envPath = serviceEnvPath();
  const configDir = path.dirname(envPath);
  const nodeProxyArgs = hasStandardNodeProxyEnv() ? ['--use-env-proxy'] : [];
  const nodeProxyArgXml = nodeProxyArgs.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const proxyEnvXml = buildLaunchdProxyEnvironmentXml();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(APP_HOME, 'logs'), { recursive: true });
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.foxden.foxclaw</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
${nodeProxyArgXml ? `${nodeProxyArgXml}\n` : ''}    <string>${xmlEscape(entryPoint)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(configDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH || '')}</string>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>USER</key>
    <string>${xmlEscape(process.env.USER || '')}</string>
    <key>LOGNAME</key>
    <string>${xmlEscape(process.env.LOGNAME || process.env.USER || '')}</string>
    <key>FOXCLAW_ENV</key>
    <string>${xmlEscape(envPath)}</string>
${proxyEnvXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(APP_HOME, 'logs', 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(APP_HOME, 'logs', 'launchd.err.log'))}</string>
</dict>
</plist>
`,
  );
  spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
  spawnChecked('launchctl', ['load', plist]);
  console.log(`Installed ${plist}`);
  if (nodeProxyArgs.length > 0) {
    console.log('[OK] launchd Node env proxy enabled');
  }
}

function stopLaunchd(): void {
  if (process.platform !== 'darwin') {
    console.error('launchd stop is only available on macOS');
    process.exit(1);
  }
  const plist = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', 'app.foxden.foxclaw.plist');
  if (!fs.existsSync(plist)) {
    console.error(`launchd plist not found: ${plist}`);
    process.exit(1);
  }
  spawnChecked('launchctl', ['unload', plist]);
  console.log(`Stopped ${plist}`);
}

function buildServicePath(nodeDir: string): string {
  const pnpmPath = resolveCommand('pnpm');
  const inferredPnpmHome = inferPnpmHomeFromEntryPoint(entryPoint) || '';
  const configuredPnpmHome = process.env.PNPM_HOME?.trim() || '';
  const parts = [
    path.join(process.env.HOME || '', '.local', 'bin'),
    nodeDir,
    inferredPnpmHome,
    inferredPnpmHome ? path.join(inferredPnpmHome, 'bin') : '',
    configuredPnpmHome,
    configuredPnpmHome ? path.join(configuredPnpmHome, 'bin') : '',
    pnpmPath ? path.dirname(pnpmPath) : '',
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(':');
}

function serviceEnvPath(): string {
  return path.resolve(process.env.FOXCLAW_ENV?.trim() || getLoadedEnvPath() || DEFAULT_ENV_PATH);
}

function currentServiceUser(): string {
  return process.env.USER?.trim()
    || process.env.LOGNAME?.trim()
    || os.userInfo().username;
}

function readSystemdUserLinger(user: string): 'enabled' | 'disabled' | 'unknown' {
  const valueResult = spawnSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { encoding: 'utf8' });
  if (valueResult.status === 0) {
    return parseSystemdUserLinger(valueResult.stdout);
  }
  const propertyResult = spawnSync('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf8' });
  if (propertyResult.status === 0) {
    return parseSystemdUserLinger(propertyResult.stdout);
  }
  return 'unknown';
}

function parseSystemdUserLinger(output: string): 'enabled' | 'disabled' | 'unknown' {
  const value = output.trim().replace(/^Linger=/, '').toLowerCase();
  if (value === 'yes') return 'enabled';
  if (value === 'no') return 'disabled';
  return 'unknown';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasStandardNodeProxyEnv(): boolean {
  return STANDARD_NODE_PROXY_ENV_KEYS.some((key) => Boolean(proxyEnvValue(key)));
}

function proxyEnvValue(key: string): string {
  return process.env[key]?.trim() || '';
}

function buildLaunchdProxyEnvironmentXml(): string {
  const entries: string[] = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = proxyEnvValue(key);
    if (!value) continue;
    entries.push(`    <key>${xmlEscape(key)}</key>`);
    entries.push(`    <string>${xmlEscape(value)}</string>`);
  }
  return entries.length > 0 ? `${entries.join('\n')}\n` : '';
}

function spawnChecked(commandName: string, args: string[]): void {
  const result = spawnSync(commandName, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function systemdEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\x20');
}

function systemdUnescape(value: string): string {
  return value.replace(/\\x20/g, ' ').replace(/\\\\/g, '\\');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function runWeixinLoginCli(): Promise<void> {
  const [
    { attachIlinkRuntimeFromBridgeLogger },
    { startWeixinLoginWithQr, waitForWeixinLogin },
    { accountFilePath, saveWeixinAccount },
    { Logger },
  ] = await Promise.all([
    import('./channels/weixin/ilink/runtime_attach.js'),
    import('./channels/weixin/ilink/login_qr.js'),
    import('./channels/weixin/account_store.js'),
    import('./logger.js'),
  ]);
  const logPath = process.env.LOG_PATH || DEFAULT_LOG_PATH;
  const level =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'warn' || process.env.LOG_LEVEL === 'error'
      ? process.env.LOG_LEVEL
      : 'info';
  const logger = new Logger(level, logPath);
  attachIlinkRuntimeFromBridgeLogger(logger, process.env.WX_ILINK_ROUTE_TAG ?? null);
  const accountsDir = process.env.WEIXIN_ACCOUNTS_DIR || path.join(APP_HOME, 'weixin', 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });
  const accountHint = process.argv.slice(3).find((a) => !a.startsWith('-'))?.trim();
  const start = await startWeixinLoginWithQr({
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    force: process.env.WX_LOGIN_FORCE === '1' || process.env.WX_LOGIN_FORCE === 'true',
    ...(accountHint ? { accountId: accountHint } : {}),
  });
  if (!start.qrcodeUrl) {
    console.error(start.message);
    process.exit(1);
  }
  console.log(start.message);
  try {
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(start.qrcodeUrl, { small: true });
  } catch {
    console.log('Open this URL in a browser to scan:', start.qrcodeUrl);
  }
  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: 'https://ilinkai.weixin.qq.com',
    verbose: process.env.WX_LOGIN_VERBOSE === '1',
    notify: (s) => process.stdout.write(s),
    onQrRefreshed: async (url: string) => {
      try {
        const qrterm = await import('qrcode-terminal');
        qrterm.default.generate(url, { small: true });
        process.stdout.write(`If the QR did not render, open:\n${url}\n`);
      } catch {
        process.stdout.write(`Open this URL to scan:\n${url}\n`);
      }
    },
  });
  if (!wait.connected || !wait.accountId || !wait.botToken) {
    console.error(wait.message);
    process.exit(1);
  }
  let baseUrl = wait.baseUrl?.trim() || 'https://ilink.weixin.qq.com';
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `https://${baseUrl}`;
  }
  saveWeixinAccount(accountsDir, {
    accountId: wait.accountId,
    botToken: wait.botToken,
    baseUrl,
    savedAt: Date.now(),
    ...(wait.userId !== undefined ? { linkedIlinkUserId: wait.userId } : {}),
  });
  console.log(`${wait.message} Account saved to ${accountFilePath(accountsDir, wait.accountId)}`);
}

void main().catch((error) => {
  if (error instanceof LockHeldError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

function hasCommand(commandName: string): boolean {
  return Boolean(resolveCommand(commandName));
}

function resolveCommand(commandName: string): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(which, [commandName], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    return result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function hasConfiguredCodexBin(binPath: string | undefined): boolean {
  if (!binPath || !binPath.trim()) return false;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function requireNode24(commandName: string): void {
  if (Number(process.versions.node.split('.')[0]) >= 24) return;
  console.error(`FoxClaw ${commandName} requires Node.js 24+. Current Node.js is ${process.version}.`);
  console.error('Install or activate Node 24, then reinstall/re-run FoxClaw:');
  console.error('  nvm install 24 && nvm use 24');
  console.error('  npm install -g @foxden-app/foxclaw@latest');
  process.exit(1);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
