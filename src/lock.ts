import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export interface ProcessLock {
  release(): void;
}

interface ProcessLockRecord {
  pid: number | null;
  processIdentity: string | null;
}

export class LockHeldError extends Error {
  constructor(lockPath: string, pid: number | null) {
    super(pid === null
      ? `Lock already held: ${lockPath}`
      : `Lock already held by pid ${pid}: ${lockPath}`);
  }
}

export function acquireProcessLock(lockPath: string): ProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return acquireProcessLockInternal(lockPath, true);
}

function acquireProcessLockInternal(lockPath: string, allowStaleRetry: boolean): ProcessLock {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify({
      pid: process.pid,
      processIdentity: readLinuxProcessIdentity(process.pid),
    })}\n`, 'utf8');
    let released = false;
    return {
      release(): void {
        if (released) {
          return;
        }
        released = true;
        try {
          fs.closeSync(fd);
        } catch {
          void 0;
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          void 0;
        }
      },
    };
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    const record = readLockRecord(lockPath);
    if (allowStaleRetry && record.pid !== null && !isLockOwnerAlive(lockPath, record)) {
      fs.rmSync(lockPath, { force: true });
      return acquireProcessLockInternal(lockPath, false);
    }
    throw new LockHeldError(lockPath, record.pid);
  }
}

function readLockRecord(lockPath: string): ProcessLockRecord {
  try {
    const value = fs.readFileSync(lockPath, 'utf8').trim();
    if (!value) {
      return { pid: null, processIdentity: null };
    }
    if (value.startsWith('{')) {
      const parsed = JSON.parse(value) as { pid?: unknown; processIdentity?: unknown };
      return {
        pid: typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null,
        processIdentity: typeof parsed.processIdentity === 'string' ? parsed.processIdentity : null,
      };
    }
    const pid = Number.parseInt(value, 10);
    return { pid: Number.isFinite(pid) ? pid : null, processIdentity: null };
  } catch {
    return { pid: null, processIdentity: null };
  }
}

function isLockOwnerAlive(lockPath: string, record: ProcessLockRecord): boolean {
  if (record.pid === null || !isProcessAlive(record.pid)) {
    return false;
  }
  const currentIdentity = readLinuxProcessIdentity(record.pid);
  if (record.processIdentity !== null && currentIdentity !== null) {
    return record.processIdentity === currentIdentity;
  }
  return !wasLockCreatedBeforeCurrentBoot(lockPath);
}

function readLinuxProcessIdentity(pid: number): string | null {
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    const startTicks = commandEnd >= 0 ? stat.slice(commandEnd + 2).split(' ')[19] : undefined;
    return bootId && startTicks ? `${bootId}:${startTicks}` : null;
  } catch {
    return null;
  }
}

function wasLockCreatedBeforeCurrentBoot(lockPath: string): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  try {
    const bootTimeSeconds = fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1];
    if (!bootTimeSeconds) {
      return false;
    }
    return fs.statSync(lockPath).mtimeMs < Number(bootTimeSeconds) * 1000;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 'EEXIST';
}
