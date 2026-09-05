import fs from 'node:fs';
import path from 'node:path';

const ID_FILE = '.foxclaw-bot.json';

/** Keep storage names readable while bot IDs remain the stable routing identity. */
export function prepareTelegramBotHome(baseDir: string, botId: string, username: string | null, sharedHome: string | null = null): string {
  if (!/^bot\d+$/.test(botId)) throw new Error('Invalid Telegram bot identity');
  if (username !== null && !/^[A-Za-z0-9_]{1,64}$/.test(username)) throw new Error('Invalid Telegram username for directory');
  const base = path.resolve(baseDir);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const legacy = path.join(base, botId);
  const legacyStat = lstat(legacy);
  const source = legacyStat?.isSymbolicLink() ? fs.realpathSync(legacy) : legacy;
  if (path.dirname(source) !== base) throw new Error(`Bot directory points outside its storage root: ${legacy}`);
  const target = username ? path.join(base, `@${username}`) : source;
  const sourceStat = lstat(source);
  const targetStat = lstat(target);
  if (sourceStat && !sourceStat.isDirectory()) throw new Error(`Bot storage is not a directory: ${source}`);
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isDirectory())) {
    throw new Error(`Bot directory name already occupied: ${target}`);
  }
  if (sourceStat) assertOwner(source, botId, source === legacy);
  if (targetStat && target !== source) {
    assertOwner(target, botId, false);
    if (sourceStat) throw new Error(`Both old and named bot directories exist; refusing to merge: ${source}, ${target}`);
  }
  if (sourceStat && source !== target) {
    writeOwner(source, botId);
    fs.renameSync(source, target);
    // Keep absolute auth links and historical paths working after the move.
    linkDirectory(target, source);
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  writeOwner(target, botId);
  if (legacy !== target && (!legacyStat || legacyStat.isSymbolicLink())) {
    linkDirectory(target, legacy);
  }
  const home = path.join(target, 'home');
  if (sharedHome) {
    const shared = path.resolve(sharedHome);
    if (shared === home || shared.startsWith(`${target}${path.sep}`)) throw new Error('Shared Codex home would create a directory cycle');
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
    if (lstat(home)) {
      if (!fs.lstatSync(home).isSymbolicLink() || fs.realpathSync(home) !== fs.realpathSync(shared)) {
        throw new Error(`Existing bot home differs from the configured shared home: ${home}`);
      }
    } else {
      linkDirectory(shared, home);
    }
  } else {
    if (lstat(home)?.isSymbolicLink()) throw new Error(`Isolated bot home unexpectedly shares another directory: ${home}`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  return home;
}

export function readTelegramBotHomeIdentity(codexHome: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(path.dirname(codexHome), ID_FILE), 'utf8'));
    return typeof value.botId === 'string' && /^bot\d+$/.test(value.botId) ? value.botId : null;
  } catch {
    return null;
  }
}

function assertOwner(directory: string, botId: string, allowLegacy: boolean): void {
  const marker = path.join(directory, ID_FILE);
  if (allowLegacy && !lstat(marker)) return;
  if (readTelegramBotHomeIdentity(path.join(directory, 'home')) !== botId) {
    throw new Error(`Bot directory belongs to another identity or has no identity record: ${directory}`);
  }
}

function writeOwner(directory: string, botId: string): void {
  fs.writeFileSync(path.join(directory, ID_FILE), `${JSON.stringify({ botId })}\n`, { mode: 0o600 });
}

function linkDirectory(target: string, link: string): void {
  const temp = `${link}.link-${process.pid}`;
  fs.symlinkSync(target, temp, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.renameSync(temp, link);
  } finally {
    if (lstat(temp)) fs.unlinkSync(temp);
  }
}

function lstat(filename: string): fs.Stats | null {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
