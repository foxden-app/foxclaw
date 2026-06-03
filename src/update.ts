import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import type { AppLocale } from './types.js';

const PACKAGE_SPEC = '@foxden-app/foxclaw@latest';
const CODEX_PACKAGE_SPEC = '@openai/codex@latest';
const UPDATE_STATUS_FILENAME = 'self-update.json';

export type SelfUpdateState = 'pending' | 'succeeded' | 'failed';

export interface SelfUpdateStatus {
  state: SelfUpdateState;
  scopeId: string;
  locale: AppLocale;
  fromVersion: string;
  toVersion: string | null;
  codexUpdate?: string | null;
  codexFromVersion?: string | null;
  codexToVersion?: string | null;
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
  pnpmHome?: string;
}

interface CreateSelfUpdateRuntimeOptions {
  entryPoint: string;
  nodePath: string;
  version: string;
  statusPath: string;
  logPath: string;
  codexCliBin?: string;
}

interface PerformSelfUpdateOptions {
  entryPoint: string;
  nodePath: string;
  version: string;
  notificationFile?: string;
  codexCliBin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SelfUpdateOutcome {
  ok: boolean;
  fromVersion: string;
  toVersion: string | null;
  error: string | null;
}

interface CodexCliUpdateResult {
  message: string;
  fromVersion: string | null;
  toVersion: string | null;
}

export function selfUpdateStatusPath(statusPath: string): string {
  return path.join(path.dirname(statusPath), UPDATE_STATUS_FILENAME);
}

export function inferPnpmHomeFromEntryPoint(entryPoint: string): string | null {
  const normalizedEntryPoint = entryPoint.replace(/\\/g, '/');
  const globalMarker = '/global/';
  const globalIndex = normalizedEntryPoint.indexOf(globalMarker);
  if (globalIndex <= 0 || !normalizedEntryPoint.includes('/.pnpm/')) {
    return null;
  }
  return normalizedEntryPoint.slice(0, globalIndex);
}

export function resolveSelfUpdateInstaller(
  entryPoint: string,
  nodePath = process.execPath,
  exists: (target: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env,
): SelfUpdateInstaller {
  const pnpmHome = inferPnpmHomeFromEntryPoint(entryPoint);
  if (pnpmHome) {
    const commandName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const candidates = executableCandidates(commandName, nodePath, env, [
      path.join(pnpmHome, commandName),
      path.join(pnpmHome, 'bin', commandName),
      env.PNPM_HOME?.trim() ? path.join(env.PNPM_HOME.trim(), commandName) : '',
      env.PNPM_HOME?.trim() ? path.join(env.PNPM_HOME.trim(), 'bin', commandName) : '',
    ]);
    const pnpmCommand = candidates.find((candidate) => exists(candidate));
    if (pnpmCommand) {
      return {
        manager: 'pnpm',
        command: pnpmCommand,
        installArgs: ['add', '--global', PACKAGE_SPEC],
        rootArgs: ['root', '--global'],
        pnpmHome,
      };
    }
    const npmCommandName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmCommand = executableCandidates(npmCommandName, nodePath, env)
      .find((candidate) => exists(candidate)) ?? npmCommandName;
    return {
      manager: 'pnpm',
      command: npmCommand,
      installArgs: ['exec', '--yes', '--package=pnpm@latest', '--', 'pnpm', 'add', '--global', PACKAGE_SPEC],
      rootArgs: ['exec', '--yes', '--package=pnpm@latest', '--', 'pnpm', 'root', '--global'],
      pnpmHome,
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

export function resolveCodexUpdateInstaller(
  codexCliBin: string,
  nodePath = process.execPath,
  exists: (target: string) => boolean = fs.existsSync,
  env: NodeJS.ProcessEnv = process.env,
  realpath: (target: string) => string = fs.realpathSync,
  readText: (target: string) => string = (target) => fs.readFileSync(target, 'utf8'),
): SelfUpdateInstaller | null {
  const resolved = resolveManagedCodexEntryPoint(codexCliBin, realpath, readText);
  if (!resolved) return null;
  const normalized = resolved.replace(/\\/g, '/');
  const pnpmManaged = normalized.includes('/global/') && normalized.includes('/.pnpm/@openai+codex@');
  const npmManaged = normalized.includes('/lib/node_modules/@openai/codex/')
    || normalized.includes('/npm/node_modules/@openai/codex/');
  if (!pnpmManaged && !npmManaged) {
    return null;
  }
  const installer = resolveSelfUpdateInstaller(resolved, nodePath, exists, env);
  return {
    ...installer,
    installArgs: installer.installArgs.map((argument) => (
      argument === PACKAGE_SPEC ? CODEX_PACKAGE_SPEC : argument
    )),
  };
}

function resolveManagedCodexEntryPoint(
  codexCliBin: string,
  realpath: (target: string) => string,
  readText: (target: string) => string,
): string | null {
  const pending = [codexCliBin];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < 4) {
    const candidate = pending.shift()!;
    let resolved = candidate;
    try {
      resolved = realpath(candidate);
    } catch {
      // Wrapper inspection below can still reveal its managed target.
    }
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    const normalized = resolved.replace(/\\/g, '/');
    if (isManagedCodexPackagePath(normalized)) {
      return resolved;
    }
    let contents = '';
    try {
      contents = readText(resolved);
    } catch {
      continue;
    }
    const embeddedPackageRoot = contents.match(/\/[^\s"']*\/global\/[^\s"']*\/\.pnpm\/@openai\+codex@[^\s"']*\/node_modules\/@openai\/codex/)?.[0];
    if (embeddedPackageRoot) {
      return path.join(embeddedPackageRoot, 'bin', 'codex.js');
    }
    const wrappedExecutable = contents.match(/\bexec\s+"([^"]*codex[^"]*)"/)?.[1];
    if (wrappedExecutable) {
      pending.push(wrappedExecutable);
    }
  }
  return null;
}

function isManagedCodexPackagePath(normalized: string): boolean {
  return (normalized.includes('/global/') && normalized.includes('/.pnpm/@openai+codex@'))
    || normalized.includes('/lib/node_modules/@openai/codex/')
    || normalized.includes('/npm/node_modules/@openai/codex/');
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
      ...(typeof parsed.codexUpdate === 'string' ? { codexUpdate: parsed.codexUpdate } : {}),
      ...(typeof parsed.codexFromVersion === 'string' ? { codexFromVersion: parsed.codexFromVersion } : {}),
      ...(typeof parsed.codexToVersion === 'string' ? { codexToVersion: parsed.codexToVersion } : {}),
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
        codexUpdate: null,
        codexFromVersion: null,
        codexToVersion: null,
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
            env: options.codexCliBin ? { ...process.env, CODEX_CLI_BIN: options.codexCliBin } : process.env,
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
          codexUpdate: null,
          codexFromVersion: null,
          codexToVersion: null,
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
  let codexUpdate: CodexCliUpdateResult | null = null;
  try {
    codexUpdate = updateManagedCodexCli(options.codexCliBin ?? env.CODEX_CLI_BIN ?? '', options.nodePath, env);
    console.log(`[UPDATE] ${codexUpdate.message}`);
    const installer = resolveSelfUpdateInstaller(options.entryPoint, options.nodePath, fs.existsSync, env);
    const installerEnv = buildInstallerEnv(options.entryPoint, installer, env);
    console.log(`[UPDATE] Installing ${PACKAGE_SPEC} with ${installer.manager}...`);
    runInherited(installer.command, installer.installArgs, installerEnv);
    const updatedEntryPoint = resolveUpdatedEntryPoint(installer, installerEnv);
    toVersion = readInstalledPackageVersion(updatedEntryPoint);
    console.log('[UPDATE] Running checks and restarting the FoxClaw service...');
    runInherited(options.nodePath, [updatedEntryPoint, 'start'], installerEnv);
    completeNotification(options.notificationFile, 'succeeded', toVersion, codexUpdate, null);
    console.log(`[OK] FoxClaw updated and restarted: ${options.version} -> ${toVersion}`);
    return {
      ok: true,
      fromVersion: options.version,
      toVersion,
      error: null,
    };
  } catch (error) {
    const message = formatError(error);
    completeNotification(options.notificationFile, 'failed', toVersion, codexUpdate, message);
    console.error(`[FAIL] FoxClaw update failed: ${message}`);
    return {
      ok: false,
      fromVersion: options.version,
      toVersion,
      error: message,
    };
  }
}

function updateManagedCodexCli(codexCliBin: string, nodePath: string, env: NodeJS.ProcessEnv): CodexCliUpdateResult {
  const fromVersion = readCodexCliVersion(codexCliBin, env);
  if (!codexCliBin) {
    return {
      message: 'Codex CLI update skipped: CODEX_CLI_BIN is not configured.',
      fromVersion,
      toVersion: fromVersion,
    };
  }
  const installer = resolveCodexUpdateInstaller(codexCliBin, nodePath, fs.existsSync, env);
  if (!installer) {
    return {
      message: 'Codex CLI update skipped: configured installation is not a recognized global npm/pnpm package.',
      fromVersion,
      toVersion: fromVersion,
    };
  }
  try {
    const installerEnv = buildInstallerEnv(fs.realpathSync(codexCliBin), installer, env);
    runInherited(installer.command, installer.installArgs, installerEnv);
    return {
      message: `Codex CLI updated with ${installer.manager}.`,
      fromVersion,
      toVersion: readCodexCliVersion(codexCliBin, installerEnv) ?? fromVersion,
    };
  } catch (error) {
    return {
      message: `Codex CLI update failed without blocking FoxClaw update: ${formatError(error)}`,
      fromVersion,
      toVersion: readCodexCliVersion(codexCliBin, env) ?? fromVersion,
    };
  }
}

function readCodexCliVersion(codexCliBin: string, env: NodeJS.ProcessEnv): string | null {
  if (!codexCliBin) {
    return null;
  }
  const result = spawnSync(codexCliBin, ['--version'], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
}

function parseCodexCliVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

function executableCandidates(
  commandName: string,
  nodePath: string,
  env: NodeJS.ProcessEnv,
  preferred: string[] = [],
): string[] {
  return [
    ...preferred,
    path.join(path.dirname(nodePath), commandName),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, commandName)),
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function buildInstallerEnv(
  entryPoint: string,
  installer: SelfUpdateInstaller,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const pnpmHome = installer.manager === 'pnpm'
    ? installer.pnpmHome ?? inferPnpmHomeFromEntryPoint(entryPoint)
    : null;
  if (!pnpmHome) {
    return env;
  }
  const configuredPnpmHome = env.PNPM_HOME?.trim() || pnpmHome;
  const pathEntries = [
    configuredPnpmHome,
    path.join(configuredPnpmHome, 'bin'),
    pnpmHome,
    path.join(pnpmHome, 'bin'),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  return {
    ...env,
    PNPM_HOME: configuredPnpmHome,
    PATH: pathEntries.filter((entry, index, all) => all.indexOf(entry) === index).join(path.delimiter),
  };
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
  codexUpdate: CodexCliUpdateResult | null,
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
    codexUpdate: codexUpdate?.message ?? null,
    codexFromVersion: codexUpdate?.fromVersion ?? null,
    codexToVersion: codexUpdate?.toVersion ?? null,
    error,
    updatedAt: new Date().toISOString(),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
