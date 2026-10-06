import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { valid } from 'semver';
import { APP_HOME, parseDshPatches } from '../config.js';
import { DshClient, type DshClientOptions } from './client.js';
import { createDshBackend } from './backend.js';
import { runBackendCommand, type BackendCandidate, type BackendSetupDefinition } from '../service/backend_setup.js';
import type { Logger } from '../logger.js';

export function createDshSetupDefinition(logger: Logger, env: NodeJS.ProcessEnv = process.env,
  installDir = path.join(APP_HOME, 'backends', 'dsh')): BackendSetupDefinition {
  const managedCli = path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const options = (candidate: BackendCandidate): DshClientOptions => {
    const startupTimeoutMs = Number(env.DSH_STARTUP_TIMEOUT_MS || 60000);
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error('DSH_STARTUP_TIMEOUT_MS must be a positive integer');
    return {
      cliBin: candidate.updates.DSH_CLI_BIN || 'dsh', sourceDir: candidate.updates.DSH_SOURCE_DIR || null,
      home: env.DSH_HOME || null, profile: env.DSH_PROFILE || 'acp', patches: parseDshPatches(env.DSH_PATCHES),
      runtimeDir: path.join(APP_HOME, 'runtime', 'dsh'), startupTimeoutMs,
    };
  };
  const fromPath = async (location: string): Promise<BackendCandidate> => {
    if (!path.isAbsolute(location) || /[\r\n\0]/.test(location)) throw new Error('请提供本机绝对路径 / An absolute local path is required');
    const target = await fs.realpath(location);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      await fs.access(path.join(target, 'apps', 'cli', 'src', 'bin.ts'));
      return { label: 'DSH 源码 / source', location: target,
        updates: { DSH_ENABLED: 'true', DSH_SOURCE_DIR: target, DSH_CLI_BIN: '' } };
    }
    if (!stat.isFile()) throw new Error('Not a CLI file or source directory');
    // Keep stable launchers and node_modules links; pnpm's real target embeds a version.
    const cli = path.resolve(location);
    await fs.access(cli, /\.[cm]?js$/.test(cli) ? fs.constants.R_OK : fs.constants.X_OK);
    return { label: 'DSH CLI', location: cli,
      updates: { DSH_ENABLED: 'true', DSH_SOURCE_DIR: '', DSH_CLI_BIN: cli } };
  };
  return {
    id: 'dsh', name: 'DeepSeek Harness (DSH)', fromPath,
    async discover() {
      const commands = (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'));
      const locations = [env.DSH_SOURCE_DIR, env.DSH_CLI_BIN, managedCli, ...commands,
        env.DEFAULT_CWD ? path.join(path.dirname(env.DEFAULT_CWD), 'deepseek-harness') : null,
        path.join(os.homedir(), 'git', 'deepseek-harness')].filter((location): location is string => Boolean(location));
      const found: BackendCandidate[] = [];
      for (const location of locations) {
        try {
          const candidate = await fromPath(location);
          if (!found.some(previous => previous.location === candidate.location)) found.push(candidate);
        } catch { /* Keep unavailable paths out of the selectable list. */ }
      }
      return found;
    },
    async validate(candidate, signal) {
      const clientOptions = options(candidate);
      const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-dsh-check-'));
      const client = new DshClient({ ...clientOptions, runtimeDir }, `setup:${randomUUID()}`, logger);
      try {
        signal.throwIfAborted();
        await client.setAccess('read-only');
        signal.throwIfAborted();
        await client.start(signal);
        signal.throwIfAborted();
      } finally {
        await client.stop();
        await fs.rm(runtimeDir, { recursive: true, force: true });
      }
    },
    factory: candidate => host => createDshBackend({ ...host.config, dsh: options(candidate) }, host.store, host.logger, host.messaging),
    async install(signal) {
      await fs.mkdir(installDir, { recursive: true, mode: 0o700 });
      const packageFile = path.join(installDir, 'package.json');
      try { await fs.access(packageFile); }
      catch { await fs.writeFile(packageFile, JSON.stringify({ name: 'foxclaw-dsh-runtime', private: true }), { mode: 0o600 }); }
      const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
      const npmCli = process.platform === 'win32'
        ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : await fs.realpath(npm);
      const installEnv = { ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}` };
      const result = await runBackendCommand(process.execPath, [npmCli, 'view', '@deepseek-ai/dsh@latest', 'version', '--json', '--registry=https://registry.npmjs.org', '--prefer-online'], installDir, installEnv, signal, 30000);
      const version: unknown = JSON.parse(result);
      if (typeof version !== 'string' || !valid(version)) throw new Error('Cannot verify official DSH version');
      await runBackendCommand(process.execPath, [npmCli, 'exec', '--yes', '--package=pnpm@10', '--', 'pnpm', '--config.minimum-release-age=0',
        'add', '--ignore-scripts', '--registry=https://registry.npmjs.org', `@deepseek-ai/dsh@${version}`], installDir, installEnv, signal);
      return fromPath(managedCli);
    },
  };
}
