import path from 'node:path';
import os from 'node:os';
import type { CodexAuthCandidateState } from '../store/database.js';
import fs from 'node:fs/promises';
import { CodexAuthState, CodexAuthCandidate, CodexAuthSwitchResult } from './state_types.js';
import { isFileMissingError } from './shared_helpers.js';

export function codexAuthDir(explicitAuthDir: string | null = null): string {
  return explicitAuthDir || process.env.CODEX_AUTH_DIR || path.join(os.homedir(), '.codex');
}

export async function listCodexAuthState(
  disabledNames = new Set<string>(),
  candidateStates = new Map<string, CodexAuthCandidateState>(),
  explicitAuthDir: string | null = null,
): Promise<CodexAuthState> {
  const authDir = codexAuthDir(explicitAuthDir);
  const authPath = path.join(authDir, 'auth.json');
  const currentTargetPath = await resolveCurrentAuthTarget(authDir, authPath);
  const candidates: CodexAuthCandidate[] = [];
  const entries = await fs.readdir(authDir, { withFileTypes: true }).catch((error) => {
    if (isFileMissingError(error)) {
      return [];
    }
    throw error;
  });

  for (const entry of entries) {
    if (!isCodexAuthCandidateName(entry.name)) {
      continue;
    }
    const candidatePath = path.join(authDir, entry.name);
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat?.isFile()) {
      continue;
    }
    candidates.push({
      name: entry.name,
      path: candidatePath,
      isCurrent: currentTargetPath === candidatePath,
      disabled: disabledNames.has(entry.name),
      state: candidateStates.get(entry.name) ?? 'active',
      mtimeMs: stat.mtimeMs,
      credentialKind: 'invalid',
      credentialLastRefreshMs: null,
      credentialExpiresAtMs: null,
      quota: null,
    });
  }

  candidates.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  return {
    authDir,
    authPath,
    currentTargetPath,
    currentLabel: currentTargetPath ? await authPathDisplayLabel(currentTargetPath) : null,
    candidates,
  };
}

export function isCodexAuthCandidateName(name: string): boolean {
  if (name === 'auth.json' || name.startsWith('.auth.json.')) {
    return false;
  }
  return name.startsWith('auth.json_') || name.startsWith('auth.json.') || name.startsWith('auth.json-');
}

export async function isCodexApiKeyAuthCandidate(candidatePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(candidatePath, 'utf8')) as { openai_api_key?: unknown };
    return typeof parsed.openai_api_key === 'string' && parsed.openai_api_key.trim().length > 0;
  } catch {
    return false;
  }
}

export function codexAuthCandidateNameFromAddName(raw: string): string | null {
  const normalized = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    return null;
  }
  const name = normalized.startsWith('auth.json_')
    || normalized.startsWith('auth.json.')
    || normalized.startsWith('auth.json-')
    ? normalized
    : `auth.json_${normalized}`;
  return isCodexAuthCandidateName(name) ? name : null;
}

export async function resolveCurrentAuthTarget(authDir: string, authPath: string): Promise<string | null> {
  const stat = await fs.lstat(authPath).catch(() => null);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(authPath);
    return path.resolve(authDir, target);
  }
  return authPath;
}

export async function resolveAuthFinalTargetPath(startPath: string): Promise<string> {
  let currentPath = startPath;
  const seen = new Set<string>();
  for (let depth = 0; depth < 20; depth += 1) {
    const absolutePath = path.resolve(currentPath);
    if (seen.has(absolutePath)) {
      return currentPath;
    }
    seen.add(absolutePath);

    const stat = await fs.lstat(currentPath).catch(() => null);
    if (!stat?.isSymbolicLink()) {
      return currentPath;
    }
    const target = await fs.readlink(currentPath);
    currentPath = path.resolve(path.dirname(currentPath), target);
  }
  return currentPath;
}

export async function authPathDisplayLabel(authPath: string): Promise<string> {
  return path.basename(await resolveAuthFinalTargetPath(authPath));
}

export async function pointCodexAuthAtTarget(authDir: string, authPath: string, targetPath: string): Promise<void> {
  await fs.mkdir(authDir, { recursive: true });
  const tempLink = path.join(authDir, `.auth.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.symlink(targetPath, tempLink);
    await fs.rename(tempLink, authPath);
  } catch (error) {
    await fs.unlink(tempLink).catch(() => {});
    throw error;
  }
}

export async function restoreCodexAuthTarget(
  authDir: string,
  authPath: string,
  targetPath: string | null,
  regularAuthContents: string | null,
): Promise<void> {
  if (regularAuthContents !== null) {
    await fs.mkdir(authDir, { recursive: true });
    const temporary = path.join(authDir, `.auth.json.${process.pid}.${Date.now()}.restore`);
    try {
      await fs.writeFile(temporary, regularAuthContents, { mode: 0o600 });
      await fs.rename(temporary, authPath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
    return;
  }
  if (targetPath) {
    await pointCodexAuthAtTarget(authDir, authPath, targetPath);
    return;
  }
  await fs.unlink(authPath).catch((error) => {
    if (!isFileMissingError(error)) {
      throw error;
    }
  });
}

export async function switchCodexAuth(targetPath: string, explicitAuthDir: string | null = null): Promise<CodexAuthSwitchResult> {
  const state = await listCodexAuthState(new Set(), new Map(), explicitAuthDir);
  const candidate = state.candidates.find(entry => entry.path === targetPath);
  if (!candidate) {
    throw new Error(`Auth candidate is no longer available: ${path.basename(targetPath)}`);
  }
  await pointCodexAuthAtTarget(state.authDir, state.authPath, candidate.path);
  return {
    fromLabel: state.currentLabel,
    toLabel: await authPathDisplayLabel(candidate.path),
  };
}
