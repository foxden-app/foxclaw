import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Logger } from '../logger.js';

export const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID ||
  ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-');
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
  ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_QUOTA_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

export interface AntigravityQuotaSnapshot {
  fiveHourPercent: number | null;
  weeklyPercent: number | null;
  resetTime5h: string | null;
  resetTimeWeekly: string | null;
  thirdParty5hPercent?: number | null;
  thirdPartyWeeklyPercent?: number | null;
  updatedAt: number;
}

export interface AntigravityAccount {
  name: string;
  filePath: string;
  email: string | null;
  isActive: boolean;
  hasRefreshToken: boolean;
  expiry: number | null;
  isCooldown?: boolean;
  cooldownRemainingSec?: number;
  isPaused?: boolean;
  quota?: AntigravityQuotaSnapshot | null;
}

export interface RefreshResult {
  success: boolean;
  account?: AntigravityAccount | undefined;
  error?: string | undefined;
  newExpiry?: number | undefined;
}

export interface RefreshAllSummary {
  total: number;
  refreshed: number;
  failed: number;
  errors: Record<string, string>;
}

export interface ImportAccountResult {
  success: boolean;
  account?: AntigravityAccount | undefined;
  error?: string | undefined;
  createdFileName?: string | undefined;
}

export interface PendingLoginSession {
  scopeId: string;
  codeVerifier: string;
  state: string;
  createdAt: number;
}

export function parseExpiryToMs(val: unknown): number | null {
  if (typeof val === 'number') {
    return val > 1e11 ? val : val * 1000;
  }
  if (typeof val === 'string') {
    const t = new Date(val).getTime();
    if (Number.isFinite(t)) return t;
    const num = Number(val);
    if (Number.isFinite(num)) {
      return num > 1e11 ? num : num * 1000;
    }
  }
  return null;
}

export function parseEmailFromIdToken(idToken: string | undefined | null): string | null {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64url').toString('utf8');
    const json = JSON.parse(decoded) as Record<string, unknown>;
    return typeof json.email === 'string' ? json.email : null;
  } catch {
    return null;
  }
}

export function formatQuotaResetTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const isSameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const timeStr = d.toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (isSameDay) {
      return timeStr;
    }
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}/${day} ${timeStr}`;
  } catch {
    return '';
  }
}

export class AntigravityAuthManager {
  readonly authDir: string;
  readonly activeTokenPath: string;
  readonly pausedAccountsPath: string;
  private readonly logger: Logger | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly cooldowns = new Map<string, number>();
  private readonly pendingLogins = new Map<string, PendingLoginSession>();
  private readonly quotaCache = new Map<string, AntigravityQuotaSnapshot>();
  private readonly pausedAccounts = new Set<string>();
  private keepAliveTimer: NodeJS.Timeout | undefined;

  constructor(authDir?: string, logger?: Logger, fetchFn: typeof fetch = fetch) {
    this.authDir = authDir || path.join(os.homedir(), '.gemini', 'antigravity-cli');
    this.activeTokenPath = path.join(this.authDir, 'antigravity-oauth-token');
    this.pausedAccountsPath = path.join(this.authDir, 'paused-accounts.json');
    this.logger = logger;
    this.fetchFn = fetchFn;
    this.loadPausedAccounts();
  }

  startBrowserLogin(scopeId: string): { authUrl: string; state: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    this.pendingLogins.set(scopeId, {
      scopeId,
      codeVerifier,
      state,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      access_type: 'offline',
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
      redirect_uri: 'https://antigravity.google/oauth-callback',
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
        'https://www.googleapis.com/auth/aicode',
        'openid',
      ].join(' '),
      state,
    });

    const authUrl = `https://accounts.google.com/o/oauth2/auth?${params.toString()}`;
    return { authUrl, state };
  }

  hasPendingLogin(scopeId: string): boolean {
    const session = this.pendingLogins.get(scopeId);
    if (!session) return false;
    if (Date.now() - session.createdAt > 10 * 60 * 1000) {
      this.pendingLogins.delete(scopeId);
      return false;
    }
    return true;
  }

  cancelBrowserLogin(scopeId: string): boolean {
    return this.pendingLogins.delete(scopeId);
  }

  async completeBrowserLogin(scopeId: string, rawInput: string): Promise<ImportAccountResult> {
    const session = this.pendingLogins.get(scopeId);
    if (!session || Date.now() - session.createdAt > 10 * 60 * 1000) {
      this.pendingLogins.delete(scopeId);
      return {
        success: false,
        error: 'Login session expired or not found. Please run /login again.',
      };
    }

    let code = rawInput.trim();
    try {
      if (code.includes('code=')) {
        const match = code.match(/code=([^&\s]+)/);
        if (match?.[1]) {
          code = decodeURIComponent(match[1]);
        }
      }
    } catch {}

    if (!code) {
      return {
        success: false,
        error: 'Could not extract authorization code from input.',
      };
    }

    try {
      const tokenParams = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        code,
        code_verifier: session.codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: 'https://antigravity.google/oauth-callback',
      });

      const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString(),
      });

      if (!res.ok) {
        const errBody = await res.text();
        this.logger?.warn('antigravity.auth.code_exchange_failed', { error: errBody });
        return {
          success: false,
          error: `Google rejected authorization code (${res.status}): ${errBody}`,
        };
      }

      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
        refresh_token?: string;
        id_token?: string;
        token_type?: string;
      };

      if (!data.refresh_token) {
        return {
          success: false,
          error: 'Google did not return a refresh_token. Please ensure you granted consent.',
        };
      }

      const email = parseEmailFromIdToken(data.id_token);
      const baseName = email ? email.replace(/[@.]/g, '_') : `acc_${Date.now().toString(36)}`;
      const cleanName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const targetFileName = `antigravity-oauth-token_${cleanName}`;
      const destPath = path.join(this.authDir, targetFileName);

      const standardData = {
        auth_method: 'consumer',
        id_token: data.id_token ?? null,
        token: {
          access_token: data.access_token,
          token_type: data.token_type || 'Bearer',
          refresh_token: data.refresh_token,
          expiry: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
        },
      };

      await this.atomicWriteJson(destPath, standardData);

      const active = await this.readActiveTokenContent();
      if (!active) {
        await this.atomicWriteJson(this.activeTokenPath, standardData);
      }

      this.pendingLogins.delete(scopeId);

      const candidates = await this.listCandidates();
      const createdAcc = candidates.find((a) => a.name === cleanName);

      return {
        success: true,
        account: createdAcc,
        createdFileName: targetFileName,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  markCooldown(nameOrEmail: string, durationMs = 30 * 60 * 1000): void {
    const until = Date.now() + durationMs;
    this.cooldowns.set(nameOrEmail.toLowerCase(), until);
    this.logger?.info('antigravity.auth.cooldown_marked', { nameOrEmail, durationMs });
  }

  clearCooldown(nameOrEmail: string): void {
    this.cooldowns.delete(nameOrEmail.toLowerCase());
  }

  isCooldown(nameOrEmail: string): boolean {
    const until = this.cooldowns.get(nameOrEmail.toLowerCase());
    return until !== undefined && until > Date.now();
  }

  getCooldownRemainingSec(nameOrEmail: string): number {
    const until = this.cooldowns.get(nameOrEmail.toLowerCase());
    if (!until || until <= Date.now()) return 0;
    return Math.ceil((until - Date.now()) / 1000);
  }

  private loadPausedAccounts(): void {
    try {
      if (fsSync.existsSync(this.pausedAccountsPath)) {
        const raw = fsSync.readFileSync(this.pausedAccountsPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.pausedAccounts.clear();
          for (const item of data) {
            if (typeof item === 'string') this.pausedAccounts.add(item.toLowerCase());
          }
        }
      }
    } catch (err) {
      this.logger?.debug('antigravity.auth.load_paused_failed', { error: String(err) });
    }
  }

  private savePausedAccounts(): void {
    try {
      fsSync.writeFileSync(this.pausedAccountsPath, JSON.stringify([...this.pausedAccounts], null, 2), 'utf8');
    } catch (err) {
      this.logger?.warn('antigravity.auth.save_paused_failed', { error: String(err) });
    }
  }

  isAccountPaused(nameOrEmail: string): boolean {
    return this.pausedAccounts.has(nameOrEmail.toLowerCase());
  }

  togglePauseAccount(targetNameOrEmail: string): boolean {
    const key = targetNameOrEmail.toLowerCase();
    if (this.pausedAccounts.has(key)) {
      this.pausedAccounts.delete(key);
      this.savePausedAccounts();
      return false;
    } else {
      this.pausedAccounts.add(key);
      this.savePausedAccounts();
      return true;
    }
  }

  pauseAccount(targetNameOrEmail: string): void {
    this.pausedAccounts.add(targetNameOrEmail.toLowerCase());
    this.savePausedAccounts();
  }

  resumeAccount(targetNameOrEmail: string): void {
    this.pausedAccounts.delete(targetNameOrEmail.toLowerCase());
    this.savePausedAccounts();
  }

  async diagnoseAndRepairAccount(targetNameOrEmail: string): Promise<{
    ok: boolean;
    accountName: string;
    email: string | null;
    message: string;
    refreshed: boolean;
  }> {
    const accounts = await this.listCandidates(false);
    const key = targetNameOrEmail.toLowerCase();
    const target = accounts.find(
      (a) =>
        a.name.toLowerCase() === key ||
        a.name === `antigravity-oauth-token_${targetNameOrEmail}` ||
        (a.email && a.email.toLowerCase() === key) ||
        (targetNameOrEmail === 'active' && a.isActive),
    );

    if (!target) {
      return {
        ok: false,
        accountName: targetNameOrEmail,
        email: null,
        message: `Account '${targetNameOrEmail}' not found.`,
        refreshed: false,
      };
    }

    if (!target.hasRefreshToken) {
      return {
        ok: false,
        accountName: target.name,
        email: target.email,
        message: 'No refresh token available. Re-authentication via device login required.',
        refreshed: false,
      };
    }

    const refreshRes = await this.refreshTokenForAccount(target.name);
    if (!refreshRes.success) {
      return {
        ok: false,
        accountName: target.name,
        email: target.email,
        message: `Token refresh failed: ${refreshRes.error || 'Unknown error'}`,
        refreshed: false,
      };
    }

    this.clearCooldown(target.name);
    if (target.email) this.clearCooldown(target.email);

    try {
      await this.fetchQuotaForAccount(target.name, true);
    } catch {}

    return {
      ok: true,
      accountName: target.name,
      email: target.email,
      message: 'Token refreshed and quota synchronized successfully.',
      refreshed: true,
    };
  }

  async diagnoseAndRepairAll(): Promise<{
    total: number;
    healthy: number;
    repaired: number;
    failed: number;
    summary: string[];
  }> {
    const accounts = await this.listCandidates(false);
    let healthy = 0;
    let repaired = 0;
    let failed = 0;
    const summary: string[] = [];

    for (const acc of accounts) {
      const res = await this.diagnoseAndRepairAccount(acc.name);
      if (res.ok) {
        if (res.refreshed) repaired++;
        else healthy++;
        summary.push(`✅ \`${res.email || res.accountName}\`: 正常/已刷新`);
      } else {
        failed++;
        summary.push(`❌ \`${res.email || res.accountName}\`: ${res.message}`);
      }
    }

    return {
      total: accounts.length,
      healthy,
      repaired,
      failed,
      summary,
    };
  }

  getCachedQuota(name: string, email?: string | null): AntigravityQuotaSnapshot | null {
    const qByName = this.quotaCache.get(name.toLowerCase());
    if (qByName) return qByName;
    if (email) {
      const qByEmail = this.quotaCache.get(email.toLowerCase());
      if (qByEmail) return qByEmail;
    }
    return null;
  }

  async fetchQuotaForAccount(targetNameOrEmail: string, force = false): Promise<AntigravityQuotaSnapshot | null> {
    const key = targetNameOrEmail.toLowerCase();
    const cached = this.quotaCache.get(key);
    if (!force && cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
      return cached;
    }

    const accounts = await this.listCandidates(false);
    const target = accounts.find(
      (a) =>
        a.name.toLowerCase() === key ||
        a.name === `antigravity-oauth-token_${targetNameOrEmail}` ||
        (a.email && a.email.toLowerCase() === key) ||
        (targetNameOrEmail === 'active' && a.isActive),
    );

    if (!target) return null;

    try {
      let content = await fs.readFile(target.filePath, 'utf8');
      let data = JSON.parse(content) as Record<string, unknown>;
      let tokenObj = (data.token as Record<string, unknown> | undefined) || {};
      let accessToken = (tokenObj.access_token as string) || (data.access_token as string) || '';
      const expiry = parseExpiryToMs(tokenObj.expiry || data.expiry);

      const now = Date.now();
      if ((!accessToken || !expiry || expiry - now < 60 * 1000) && target.hasRefreshToken) {
        const refRes = await this.refreshTokenForAccount(target.name);
        if (refRes.success) {
          content = await fs.readFile(target.filePath, 'utf8');
          data = JSON.parse(content) as Record<string, unknown>;
          tokenObj = (data.token as Record<string, unknown> | undefined) || {};
          accessToken = (tokenObj.access_token as string) || (data.access_token as string) || '';
        }
      }

      if (!accessToken) return null;

      let res = await this.fetchFn(GOOGLE_QUOTA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity',
        },
        body: '{}',
      });

      if (res.status === 401 && target.hasRefreshToken) {
        const refRes = await this.refreshTokenForAccount(target.name);
        if (refRes.success) {
          content = await fs.readFile(target.filePath, 'utf8');
          data = JSON.parse(content) as Record<string, unknown>;
          tokenObj = (data.token as Record<string, unknown> | undefined) || {};
          accessToken = (tokenObj.access_token as string) || (data.access_token as string) || '';
          if (accessToken) {
            res = await this.fetchFn(GOOGLE_QUOTA_ENDPOINT, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity',
              },
              body: '{}',
            });
          }
        }
      }

      if (!res.ok) {
        this.logger?.warn('antigravity.auth.quota_fetch_failed', {
          account: target.name,
          status: res.status,
        });
        return cached ?? null;
      }

      const resJson = (await res.json()) as {
        groups?: Array<{
          displayName?: string;
          buckets?: Array<{
            bucketId?: string;
            window?: string;
            resetTime?: string;
            remainingFraction?: number;
          }>;
        }>;
      };

      let fiveHourPercent: number | null = null;
      let weeklyPercent: number | null = null;
      let resetTime5h: string | null = null;
      let resetTimeWeekly: string | null = null;
      let thirdParty5hPercent: number | null = null;
      let thirdPartyWeeklyPercent: number | null = null;

      if ((resJson as any).userQuotaSummary) {
        const u = (resJson as any).userQuotaSummary;
        if (typeof u.fiveHourPercent === 'number') fiveHourPercent = u.fiveHourPercent;
        if (typeof u.weeklyPercent === 'number') weeklyPercent = u.weeklyPercent;
        if (typeof u.resetTime5h === 'string') resetTime5h = u.resetTime5h;
        if (typeof u.resetTimeWeekly === 'string') resetTimeWeekly = u.resetTimeWeekly;
      }

      for (const group of resJson.groups || []) {
        const isGemini =
          group.displayName === 'Gemini Models' ||
          group.buckets?.some((b) => b.bucketId?.startsWith('gemini'));
        const is3P =
          group.displayName === 'Claude and GPT models' ||
          group.buckets?.some((b) => b.bucketId?.startsWith('3p'));

        for (const b of group.buckets || []) {
          const pct =
            typeof b.remainingFraction === 'number'
              ? Math.max(0, Math.min(100, Math.round(b.remainingFraction * 100)))
              : null;
          if (isGemini) {
            if (b.window === '5h' || b.bucketId === 'gemini-5h') {
              fiveHourPercent = pct;
              resetTime5h = b.resetTime || null;
            } else if (b.window === 'weekly' || b.bucketId === 'gemini-weekly') {
              weeklyPercent = pct;
              resetTimeWeekly = b.resetTime || null;
            }
          } else if (is3P) {
            if (b.window === '5h' || b.bucketId === '3p-5h') {
              thirdParty5hPercent = pct;
            } else if (b.window === 'weekly' || b.bucketId === '3p-weekly') {
              thirdPartyWeeklyPercent = pct;
            }
          }
        }
      }

      const snapshot: AntigravityQuotaSnapshot = {
        fiveHourPercent,
        weeklyPercent,
        resetTime5h,
        resetTimeWeekly,
        thirdParty5hPercent,
        thirdPartyWeeklyPercent,
        updatedAt: Date.now(),
      };

      this.quotaCache.set(target.name.toLowerCase(), snapshot);
      if (target.email) {
        this.quotaCache.set(target.email.toLowerCase(), snapshot);
      }

      return snapshot;
    } catch (err) {
      this.logger?.warn('antigravity.auth.quota_fetch_error', {
        account: target.name,
        error: String(err),
      });
      return cached ?? null;
    }
  }

  async populateQuotas(candidates: AntigravityAccount[], force = false): Promise<void> {
    await Promise.allSettled(
      candidates.map(async (acc) => {
        acc.quota = await this.fetchQuotaForAccount(acc.name, force);
      }),
    );
  }

  async listCandidates(includeQuotas = false, forceQuotaRefresh = false): Promise<AntigravityAccount[]> {
    try {
      const files = await fs.readdir(this.authDir);
      const candidateNames = files.filter(
        (f) => f.startsWith('antigravity-oauth-token_') && !f.endsWith('.tmp'),
      );

      const activeContent = await this.readActiveTokenContent();
      const accounts: AntigravityAccount[] = [];

      for (const name of candidateNames) {
        const filePath = path.join(this.authDir, name);
        const account = await this.parseAccountFile(name, filePath, activeContent);
        if (account) {
          const cd = Math.max(
            this.getCooldownRemainingSec(account.name),
            account.email ? this.getCooldownRemainingSec(account.email) : 0,
          );
          account.isCooldown = cd > 0;
          account.cooldownRemainingSec = cd;
          account.isPaused = this.isAccountPaused(account.name) || (account.email ? this.isAccountPaused(account.email) : false);
          account.quota = this.getCachedQuota(account.name, account.email);
          accounts.push(account);
        }
      }

      const hasActiveMatch = accounts.some((a) => a.isActive);
      if (!hasActiveMatch && activeContent) {
        const defaultAccount = await this.parseAccountFile(
          'active',
          this.activeTokenPath,
          activeContent,
        );
        if (defaultAccount) {
          defaultAccount.isActive = true;
          const cd = Math.max(
            this.getCooldownRemainingSec(defaultAccount.name),
            defaultAccount.email ? this.getCooldownRemainingSec(defaultAccount.email) : 0,
          );
          defaultAccount.isCooldown = cd > 0;
          defaultAccount.cooldownRemainingSec = cd;
          defaultAccount.isPaused = this.isAccountPaused(defaultAccount.name) || (defaultAccount.email ? this.isAccountPaused(defaultAccount.email) : false);
          defaultAccount.quota = this.getCachedQuota(defaultAccount.name, defaultAccount.email);
          accounts.unshift(defaultAccount);
        }
      }

      if (includeQuotas) {
        await this.populateQuotas(accounts, forceQuotaRefresh);
      }

      return accounts;
    } catch (error) {
      this.logger?.warn('antigravity.auth.list_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async getActiveAccount(): Promise<AntigravityAccount | null> {
    const accounts = await this.listCandidates();
    return accounts.find((a) => a.isActive) ?? accounts[0] ?? null;
  }

  async switchAccount(targetNameOrEmail: string): Promise<{ success: boolean; account: AntigravityAccount }> {
    const accounts = await this.listCandidates();
    const target = accounts.find(
      (a) =>
        a.name === targetNameOrEmail ||
        a.name === `antigravity-oauth-token_${targetNameOrEmail}` ||
        (a.email && a.email.toLowerCase() === targetNameOrEmail.toLowerCase()),
    );

    if (!target) {
      throw new Error(`Antigravity account '${targetNameOrEmail}' not found in candidate pool.`);
    }

    // If target token is expired or expiring within 5 min (300s), refresh it before switching
    const now = Date.now();
    if (target.hasRefreshToken && (!target.expiry || target.expiry - now < 300 * 1000)) {
      const refreshed = await this.refreshTokenForAccount(target.name);
      if (refreshed.success && refreshed.account) {
        target.expiry = refreshed.newExpiry ?? null;
      }
    }

    if (target.filePath === this.activeTokenPath) {
      return { success: true, account: target };
    }

    // Atomic replace activeTokenPath
    await this.atomicCopy(target.filePath, this.activeTokenPath);
    this.logger?.info('antigravity.auth.switched', {
      name: target.name,
      email: target.email,
    });

    target.isActive = true;
    return { success: true, account: target };
  }

  async rotateNextCandidate(currentAccountName?: string): Promise<{ success: boolean; account: AntigravityAccount }> {
    const accounts = await this.listCandidates();
    if (accounts.length <= 1) {
      throw new Error('No alternative Antigravity accounts available for rotation.');
    }

    // Filter accounts not in cooldown and not paused
    const available = accounts.filter((a) => !a.isCooldown && !a.isPaused);
    const pool = available.length > 0 ? available : accounts.filter((a) => !a.isPaused);
    if (pool.length === 0) {
      throw new Error('All Antigravity accounts are currently paused.');
    }

    const currentIdx = pool.findIndex(
      (a) => a.isActive || (currentAccountName && a.name === currentAccountName),
    );
    const nextIdx = (currentIdx + 1) % pool.length;
    const nextAccount = pool[nextIdx]!;

    return this.switchAccount(nextAccount.name);
  }

  async refreshTokenForAccount(targetNameOrEmail: string): Promise<RefreshResult> {
    const accounts = await this.listCandidates();
    const target = accounts.find(
      (a) =>
        a.name.toLowerCase() === targetNameOrEmail.toLowerCase() ||
        a.name === `antigravity-oauth-token_${targetNameOrEmail}` ||
        (a.email && a.email.toLowerCase() === targetNameOrEmail.toLowerCase()) ||
        (targetNameOrEmail === 'active' && a.isActive),
    );

    if (!target) {
      return {
        success: false,
        error: `Account '${targetNameOrEmail}' not found in candidate pool.`,
      };
    }

    try {
      const content = await fs.readFile(target.filePath, 'utf8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const tokenObj = (data.token as Record<string, unknown> | undefined) || {};
      const refreshToken =
        (typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token) ||
        (typeof data.refresh_token === 'string' && data.refresh_token) ||
        null;

      if (!refreshToken) {
        return {
          success: false,
          error: `No refresh_token found for account '${target.name}'.`,
        };
      }

      const params = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      const res = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.logger?.warn('antigravity.auth.refresh_failed', {
          account: target.name,
          status: res.status,
          error: errText,
        });
        return {
          success: false,
          error: `Google API returned status ${res.status}: ${errText}`,
        };
      }

      const resJson = (await res.json()) as {
        access_token: string;
        expires_in: number;
        id_token?: string;
        token_type?: string;
      };

      const newExpiryIso = new Date(Date.now() + (resJson.expires_in ?? 3600) * 1000).toISOString();
      const updatedTokenObj = {
        ...tokenObj,
        access_token: resJson.access_token,
        token_type: resJson.token_type || (tokenObj.token_type as string) || 'Bearer',
        expiry: newExpiryIso,
      };

      data.token = updatedTokenObj;
      if (resJson.id_token) {
        data.id_token = resJson.id_token;
      }

      await this.atomicWriteJson(target.filePath, data);

      if (target.isActive || target.filePath === this.activeTokenPath) {
        await this.atomicWriteJson(this.activeTokenPath, data);
      }

      this.clearCooldown(target.name);
      if (target.email) this.clearCooldown(target.email);

      const refreshedExpiry = parseExpiryToMs(newExpiryIso);
      const updatedAccounts = await this.listCandidates();
      const updatedAcc = updatedAccounts.find((a) => a.name === target.name) || target;

      this.logger?.info('antigravity.auth.refreshed', {
        account: target.name,
        email: target.email,
        expiresIn: resJson.expires_in,
      });

      return {
        success: true,
        account: updatedAcc,
        newExpiry: refreshedExpiry ?? undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn('antigravity.auth.refresh_exception', {
        account: target.name,
        error: msg,
      });
      return {
        success: false,
        error: msg,
      };
    }
  }

  async refreshAllTokens(): Promise<RefreshAllSummary> {
    const candidates = await this.listCandidates();
    let refreshed = 0;
    let failed = 0;
    const errors: Record<string, string> = {};

    for (const c of candidates) {
      if (!c.hasRefreshToken) continue;
      const res = await this.refreshTokenForAccount(c.name);
      if (res.success) {
        refreshed++;
      } else {
        failed++;
        errors[c.name] = res.error || 'Unknown error';
      }
    }

    return {
      total: candidates.length,
      refreshed,
      failed,
      errors,
    };
  }

  async ensureActiveTokenFresh(thresholdSec = 300): Promise<boolean> {
    const active = await this.getActiveAccount();
    if (!active || !active.hasRefreshToken) return false;

    const expiry = active.expiry;
    const now = Date.now();
    if (!expiry || expiry - now < thresholdSec * 1000) {
      this.logger?.info('antigravity.auth.preflight_refresh', {
        account: active.name,
        remainingSec: expiry ? Math.round((expiry - now) / 1000) : 0,
      });
      const res = await this.refreshTokenForAccount(active.name);
      return res.success;
    }
    return false;
  }

  async importAccountFromJson(rawJson: string, preferredName?: string): Promise<ImportAccountResult> {
    try {
      const data = JSON.parse(rawJson.trim()) as Record<string, unknown>;
      const tokenObj = (data.token as Record<string, unknown> | undefined) || {};
      const refreshToken =
        (typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token) ||
        (typeof data.refresh_token === 'string' && data.refresh_token) ||
        null;

      if (!refreshToken) {
        return {
          success: false,
          error: 'Missing refresh_token in credentials JSON.',
        };
      }

      const idToken =
        (typeof data.id_token === 'string' && data.id_token) ||
        (typeof tokenObj.id_token === 'string' && tokenObj.id_token) ||
        undefined;

      const email = parseEmailFromIdToken(idToken) || (typeof data.email === 'string' ? data.email : null);

      let baseName = preferredName;
      if (!baseName && email) {
        baseName = email.replace(/[@.]/g, '_');
      }
      if (!baseName) {
        baseName = `acc_${Date.now().toString(36)}`;
      }

      const cleanName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const targetFileName = `antigravity-oauth-token_${cleanName}`;
      const destPath = path.join(this.authDir, targetFileName);

      const standardData = {
        auth_method: 'consumer',
        id_token: idToken ?? null,
        token: {
          access_token: (tokenObj.access_token as string) || (data.access_token as string) || '',
          token_type: (tokenObj.token_type as string) || (data.token_type as string) || 'Bearer',
          refresh_token: refreshToken,
          expiry: (tokenObj.expiry as string) || (data.expiry as string) || new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      };

      await this.atomicWriteJson(destPath, standardData);

      const refreshRes = await this.refreshTokenForAccount(cleanName);
      if (!refreshRes.success) {
        await fs.unlink(destPath).catch(() => {});
        return {
          success: false,
          error: `Token verification failed with Google: ${refreshRes.error}`,
        };
      }

      return {
        success: true,
        account: refreshRes.account,
        createdFileName: targetFileName,
      };
    } catch (err) {
      return {
        success: false,
        error: `Invalid JSON format: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  startKeepAlive(intervalMs = 30 * 60 * 1000): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      this.runKeepAliveCheck().catch((err) => {
        this.logger?.warn('antigravity.auth.keepalive_error', { error: String(err) });
      });
    }, intervalMs);
    this.keepAliveTimer?.unref?.();

    const initialTimer = setTimeout(() => {
      this.runKeepAliveCheck().catch(() => {});
    }, 3000);
    initialTimer?.unref?.();
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  async runKeepAliveCheck(): Promise<void> {
    // Only refresh the active account to keep the active session warm without spamming Google OAuth
    const active = await this.getActiveAccount();
    if (!active || !active.hasRefreshToken) return;

    const now = Date.now();
    if (!active.expiry || active.expiry - now < 15 * 60 * 1000) {
      this.logger?.info('antigravity.auth.keepalive_refreshing_active', {
        account: active.name,
        email: active.email,
        expiry: active.expiry ? new Date(active.expiry).toISOString() : 'none',
      });
      await this.refreshTokenForAccount(active.name);
    }
  }

  private async parseAccountFile(
    name: string,
    filePath: string,
    activeContent: string | null,
  ): Promise<AntigravityAccount | null> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const idToken = typeof data.id_token === 'string' ? data.id_token : undefined;
      const email = parseEmailFromIdToken(idToken);
      const tokenObj = data.token as Record<string, unknown> | undefined;
      const hasRefreshToken = Boolean(tokenObj?.refresh_token || (data as Record<string, unknown>).refresh_token);
      const expiry = parseExpiryToMs(tokenObj?.expiry || (data as Record<string, unknown>).expiry);

      const isActive = activeContent ? content.trim() === activeContent.trim() : false;

      const cleanName = name.startsWith('antigravity-oauth-token_')
        ? name.slice('antigravity-oauth-token_'.length)
        : name;

      return {
        name: cleanName,
        filePath,
        email,
        isActive,
        hasRefreshToken,
        expiry,
      };
    } catch {
      return null;
    }
  }

  private async readActiveTokenContent(): Promise<string | null> {
    try {
      return await fs.readFile(this.activeTokenPath, 'utf8');
    } catch {
      return null;
    }
  }

  private async atomicCopy(sourcePath: string, destPath: string): Promise<void> {
    const tempPath = `${destPath}.${Date.now()}.${process.pid}.tmp`;
    const content = await fs.readFile(sourcePath);
    await fs.writeFile(tempPath, content, { mode: 0o600 });
    await fs.rename(tempPath, destPath);
  }

  private async atomicWriteJson(destPath: string, data: unknown): Promise<void> {
    const tempPath = `${destPath}.${Date.now()}.${process.pid}.tmp`;
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(tempPath, content, { mode: 0o600, encoding: 'utf8' });
    await fs.rename(tempPath, destPath);
  }
}
