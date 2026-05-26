import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import type { AppLocale } from './types.js';

const PACKAGE_SPEC = '@foxden-app/foxclaw@latest';
const UPDATE_STATUS_FILENAME = 'self-update.json';

export type SelfUpdateState = 'pending' | 'succeeded' | 'failed';

export interface SelfUpdateStatus {
  state: SelfUpdateState;
  scopeId: string;
  locale: AppLocale;
  fromVersion: string;
  toVersion: string | null;
  error: string | null;
  updatedAt: string;
}

export interface SelfUpdateRuntime {
  launch(scopeId: string, locale: AppLocale): Promise<void>;
  readStatus(): Promise<SelfUpdateStatus | null>;
  clearStatus(): Promise<void>;
}

export interface SelfUpdateInstaller {
  manager: 'npm' | 'pnpm';
  command: string;
  installArgs: string[];
  rootArgs: string[];
}

interface CreateSelfUpdateRuntimeOptions {
  entryPoint: string;
  nodePath: string;
  version: string;
  statusPath: string;
  logPath: string;
}

interface PerformSelfUpdateOptions {
  entryPoint: string;
  nodePath: string;
  version: string;
  notificationFile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SelfUpdateOutcome {
  ok: boolean;
  fromVersion: string;
  toVersion: string | null;
  error: string | null;
}

export function selfUpdateStatusPath(statusPath: string): string {
  return path.join(path.dirname(statusPath), UPDATE_STATUS_FILENAME);
}

export function resolveSelfUpdateInstaller(
  entryPoint: string,
  nodePath = process.execPath,
  exists: (target: string) => boolean = fs.existsSync,
): SelfUpdateInstaller {
  const normalizedEntryPoint = entryPoint.replace(/\\/g, '/');
  const globalMarker = '/global/';
  const globalIndex = normalizedEntryPoint.indexOf(globalMarker);
  if (globalIndex > 0 && normalizedEntryPoint.includes('/.pnpm/')) {
    const pnpmHome = normalizedEntryPoint.slice(0, globalIndex);
    const pnpmCommand = path.join(pnpmHome, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    if (!exists(pnpmCommand)) {
      throw new Error(`Current installation is managed by pnpm, but pnpm was not found at ${pnpmCommand}.`);
    }
    return {
      manager: 'pnpm',
      command: pnpmCommand,
      installArgs: ['add', '--global', PACKAGE_SPEC],
      rootArgs: ['root', '--global'],
    };
  }

  const adjacentNpm = path.join(path.dirname(nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return {
    manager: 'npm',
    command: exists(adjacentNpm) ? adjacentNpm : (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    installArgs: ['install', '--global', PACKAGE_SPEC],
    rootArgs: ['root', '--global'],
  };
}

export function readSelfUpdateStatus(statusFile: string): SelfUpdateStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Partial<SelfUpdateStatus>;
    if (
      (parsed.state !== 'pending' && parsed.state !== 'succeeded' && parsed.state !== 'failed')
      || typeof parsed.scopeId !== 'string'
      || (parsed.locale !== 'en' && parsed.locale !== 'zh')
      || typeof parsed.fromVersion !== 'string'
      || typeof parsed.updatedAt !== 'string'
    ) {
      return null;
    }
    return {
      state: parsed.state,
      scopeId: parsed.scopeId,
      locale: parsed.locale,
      fromVersion: parsed.fromVersion,
      toVersion: typeof parsed.toVersion === 'string' ? parsed.toVersion : null,
      error: typeof parsed.error === 'string' ? parsed.error : null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeSelfUpdateStatus(statusFile: string, status: SelfUpdateStatus): void {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const temporaryFile = `${statusFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(status, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, statusFile);
}

export function createSelfUpdateRuntime(options: CreateSelfUpdateRuntimeOptions): SelfUpdateRuntime {
  const statusFile = selfUpdateStatusPath(options.statusPath);
  return {
    async launch(scopeId: string, locale: AppLocale): Promise<void> {
      const current = readSelfUpdateStatus(statusFile);
      if (current?.state === 'pending') {
        throw new Error('A FoxClaw update is already running.');
      }
      writeSelfUpdateStatus(statusFile, {
        state: 'pending',
        scopeId,
        locale,
        fromVersion: options.version,
        toVersion: null,
        error: null,
        updatedAt: new Date().toISOString(),
      });
      fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
      const logFd = fs.openSync(options.logPath, 'a', 0o600);
      try {
        const child = spawn(
          options.nodePath,
          [options.entryPoint, 'update', '--notification-file', statusFile],
          {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: process.env,
          },
        );
        child.unref();
      } catch (error) {
        writeSelfUpdateStatus(statusFile, {
          state: 'failed',
          scopeId,
          locale,
          fromVersion: options.version,
          toVersion: null,
          error: formatError(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      } finally {
        fs.closeSync(logFd);
      }
    },
    async readStatus(): Promise<SelfUpdateStatus | null> {
      return readSelfUpdateStatus(statusFile);
    },
    async clearStatus(): Promise<void> {
      fs.rmSync(statusFile, { force: true });
    },
  };
}

export function performSelfUpdate(options: PerformSelfUpdateOptions): SelfUpdateOutcome {
  const env = options.env ?? process.env;
  let toVersion: string | null = null;
  try {
    const installer = resolveSelfUpdateInstaller(options.entryPoint, options.nodePath);
    console.log(`[UPDATE] Installing ${PACKAGE_SPEC} with ${installer.manager}...`);
    runInherited(installer.command, installer.installArgs, env);
    const updatedEntryPoint = resolveUpdatedEntryPoint(installer, env);
    toVersion = readInstalledPackageVersion(updatedEntryPoint);
    console.log('[UPDATE] Running checks and restarting the FoxClaw service...');
    runInherited(options.nodePath, [updatedEntryPoint, 'start'], env);
    completeNotification(options.notificationFile, 'succeeded', toVersion, null);
    console.log(`[OK] FoxClaw updated and restarted: ${options.version} -> ${toVersion}`);
    return {
      ok: true,
      fromVersion: options.version,
      toVersion,
      error: null,
    };
  } catch (error) {
    const message = formatError(error);
    completeNotification(options.notificationFile, 'failed', toVersion, message);
    console.error(`[FAIL] FoxClaw update failed: ${message}`);
    return {
      ok: false,
      fromVersion: options.version,
      toVersion,
      error: message,
    };
  }
}

function runInherited(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}.`);
  }
}

function resolveUpdatedEntryPoint(installer: SelfUpdateInstaller, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(installer.command, installer.rootArgs, { encoding: 'utf8', env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not locate the updated global package root using ${installer.manager}.`);
  }
  const globalRoot = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!globalRoot) {
    throw new Error(`Could not locate the updated global package root using ${installer.manager}.`);
  }
  const updatedEntryPoint = path.join(globalRoot, '@foxden-app', 'foxclaw', 'dist', 'main.js');
  if (!fs.existsSync(updatedEntryPoint)) {
    throw new Error(`Updated FoxClaw entry point was not found at ${updatedEntryPoint}.`);
  }
  return updatedEntryPoint;
}

function readInstalledPackageVersion(updatedEntryPoint: string): string {
  try {
    const packageFile = path.resolve(path.dirname(updatedEntryPoint), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function completeNotification(
  notificationFile: string | undefined,
  state: Extract<SelfUpdateState, 'succeeded' | 'failed'>,
  toVersion: string | null,
  error: string | null,
): void {
  if (!notificationFile) {
    return;
  }
  const pending = readSelfUpdateStatus(notificationFile);
  if (!pending) {
    return;
  }
  writeSelfUpdateStatus(notificationFile, {
    ...pending,
    state,
    toVersion,
    error,
    updatedAt: new Date().toISOString(),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
