#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  APP_HOME,
  DEFAULT_ENV_PATH,
  DEFAULT_LOG_PATH,
  DEFAULT_STATUS_PATH,
  loadConfig,
  loadEnv,
} from './config.js';
import { acquireProcessLock, LockHeldError } from './lock.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtime.js';

const command = process.argv[2] || 'serve';
loadEnv();
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entryPoint = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
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

  requireNode24(command);
  await runServeCli();
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
  ]);
  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);
  attachIlinkRuntimeFromBridgeLogger(logger, config.wxIlinkRouteTag);
  const processLock = acquireProcessLock(config.lockPath);
  let store: InstanceType<typeof BridgeStore> | null = null;
  let weixinAdapter: InstanceType<typeof WeixinChannelAdapter> | null = null;
  try {
    store = new BridgeStore(config.storePath);
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
    const core = new BridgeSessionCore(config, store, logger, bot, app, outbound);
    const telegram = new TelegramChannelAdapter(core);
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
        activeTurns: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
        channels: { telegram: false, weixin: false },
      });
      store?.close();
      processLock.release();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    await weixinAdapter?.stop().catch(() => {});
    store?.close();
    processLock.release();
    throw error;
  }
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
        console.log(`Edit it manually, then run: foxclaw doctor`);
        return;
      }
    } else {
      console.log('Interactive setup. Press Enter to skip any field and edit it later.');
    }

    const updates: Record<string, string> = {};
    const skipped: string[] = [];
    const warnings: string[] = [];

    const token = sanitizeEnvInput(await rl.question('Telegram bot token (TG_BOT_TOKEN): '));
    if (token) {
      updates.TG_BOT_TOKEN = token;
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        warnings.push('TG_BOT_TOKEN does not look like a standard Telegram bot token.');
      }
    } else {
      skipped.push('TG_BOT_TOKEN');
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
    ['telegram bot token configured', Boolean(process.env.TG_BOT_TOKEN)],
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
  return passed;
}

function installSystemd(): void {
  if (!hasCommand('systemctl')) {
    console.error('systemctl not found (need systemd)');
    process.exit(1);
  }
  const unitName = 'foxclaw.service';
  const userSystemdDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'systemd', 'user');
  const unitPath = path.join(userSystemdDir, unitName);
  const configDir = path.dirname(process.env.FOXCLAW_ENV?.trim() || DEFAULT_ENV_PATH);
  const nodeBin = process.execPath;
  const nodeDir = path.dirname(nodeBin);
  const pathValue = buildServicePath(nodeDir);
  fs.mkdirSync(userSystemdDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(APP_HOME, 'logs'), { recursive: true });
  const foxclawEnvLine = process.env.FOXCLAW_ENV?.trim()
    ? `Environment=FOXCLAW_ENV=${systemdEscape(process.env.FOXCLAW_ENV.trim())}\n`
    : '';
  fs.writeFileSync(
    unitPath,
    `[Unit]
Description=FoxClaw local Codex execution bridge
Documentation=https://github.com/foxden-app/foxclaw
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${systemdEscape(configDir)}
Environment=HOME=${systemdEscape(process.env.HOME || '')}
Environment=USER=${systemdEscape(process.env.USER || '')}
Environment=LOGNAME=${systemdEscape(process.env.LOGNAME || process.env.USER || '')}
Environment=PATH=${systemdEscape(pathValue)}
${foxclawEnvLine}ExecStart=${systemdEscape(nodeBin)} ${systemdEscape(entryPoint)} serve
Restart=always
RestartSec=10
TimeoutStopSec=45
KillMode=process

[Install]
WantedBy=default.target
`,
  );
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
  const configDir = path.dirname(process.env.FOXCLAW_ENV?.trim() || DEFAULT_ENV_PATH);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(APP_HOME, 'logs'), { recursive: true });
  const foxclawEnvXml = process.env.FOXCLAW_ENV?.trim()
    ? `    <key>FOXCLAW_ENV</key>
    <string>${xmlEscape(process.env.FOXCLAW_ENV.trim())}</string>
`
    : '';
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
    <string>${xmlEscape(entryPoint)}</string>
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
${foxclawEnvXml}
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
  const parts = [
    path.join(process.env.HOME || '', '.local', 'bin'),
    nodeDir,
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ];
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(':');
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
