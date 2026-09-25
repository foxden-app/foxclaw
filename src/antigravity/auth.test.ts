import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  AntigravityAuthManager,
  parseEmailFromIdToken,
  parseExpiryToMs,
} from './auth.js';

function makeMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mocksignature`;
}

test('parseEmailFromIdToken correctly decodes email claim from JWT', () => {
  const jwt = makeMockJwt({ email: 'developer@example.com', sub: '12345' });
  const email = parseEmailFromIdToken(jwt);
  assert.equal(email, 'developer@example.com');

  assert.equal(parseEmailFromIdToken(undefined), null);
  assert.equal(parseEmailFromIdToken('invalid-jwt'), null);
});

test('parseExpiryToMs parses ISO dates and epoch timestamps', () => {
  const iso = '2026-09-24T22:59:33.985Z';
  const expectedMs = new Date(iso).getTime();
  assert.equal(parseExpiryToMs(iso), expectedMs);

  assert.equal(parseExpiryToMs(1790261973), 1790261973000);
  assert.equal(parseExpiryToMs(1790261973985), 1790261973985);
  assert.equal(parseExpiryToMs('1790261973'), 1790261973000);
  assert.equal(parseExpiryToMs(null), null);
  assert.equal(parseExpiryToMs('not-a-date'), null);
});

test('AntigravityAuthManager lists candidates and supports atomic switching & rotation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-auth-test-'));

  try {
    const token1 = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'user1@gmail.com' }),
      token: {
        access_token: 'acc-1',
        refresh_token: 'ref-1',
        expiry: 1800000000,
      },
    };

    const token2 = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'user2@gmail.com' }),
      token: {
        access_token: 'acc-2',
        refresh_token: 'ref-2',
        expiry: 1800000000,
      },
    };

    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token_account1'),
      JSON.stringify(token1, null, 2),
    );
    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token_account2'),
      JSON.stringify(token2, null, 2),
    );
    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token'),
      JSON.stringify(token1, null, 2),
    );

    const manager = new AntigravityAuthManager(tempDir);
    const candidates = await manager.listCandidates();

    assert.equal(candidates.length, 2);
    const acc1 = candidates.find((c) => c.name === 'account1');
    const acc2 = candidates.find((c) => c.name === 'account2');

    assert.ok(acc1);
    assert.ok(acc2);
    assert.equal(acc1.email, 'user1@gmail.com');
    assert.equal(acc1.isActive, true);
    assert.equal(acc2.email, 'user2@gmail.com');
    assert.equal(acc2.isActive, false);

    const switchRes = await manager.switchAccount('account2');
    assert.equal(switchRes.success, true);
    assert.equal(switchRes.account.name, 'account2');

    const activeContent = JSON.parse(
      await fs.readFile(path.join(tempDir, 'antigravity-oauth-token'), 'utf8'),
    );
    assert.equal(activeContent.token.access_token, 'acc-2');

    const rotateRes = await manager.rotateNextCandidate('account2');
    assert.equal(rotateRes.success, true);
    assert.equal(rotateRes.account.name, 'account1');

    const rotatedContent = JSON.parse(
      await fs.readFile(path.join(tempDir, 'antigravity-oauth-token'), 'utf8'),
    );
    assert.equal(rotatedContent.token.access_token, 'acc-1');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('refreshTokenForAccount and refreshAllTokens update tokens on disk via mock fetch', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-refresh-test-'));

  try {
    const tokenData = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'refresh@example.com' }),
      token: {
        access_token: 'old-access-token',
        refresh_token: 'valid-refresh-token',
        expiry: '2020-01-01T00:00:00.000Z',
      },
    };

    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token_primary'),
      JSON.stringify(tokenData, null, 2),
    );
    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token'),
      JSON.stringify(tokenData, null, 2),
    );

    // Mock fetch implementation
    let calledCount = 0;
    const mockFetch = async () => {
      calledCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-refreshed-token-123',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as unknown as Response;
    };

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch as typeof fetch);

    // Refresh primary
    const res = await manager.refreshTokenForAccount('primary');
    assert.equal(res.success, true);
    assert.equal(calledCount, 1);

    // Verify on disk
    const saved = JSON.parse(
      await fs.readFile(path.join(tempDir, 'antigravity-oauth-token_primary'), 'utf8'),
    );
    assert.equal(saved.token.access_token, 'new-refreshed-token-123');

    // Verify active file was also updated
    const savedActive = JSON.parse(
      await fs.readFile(path.join(tempDir, 'antigravity-oauth-token'), 'utf8'),
    );
    assert.equal(savedActive.token.access_token, 'new-refreshed-token-123');

    // Test refreshAllTokens
    const allSummary = await manager.refreshAllTokens();
    assert.equal(allSummary.refreshed, 1);
    assert.equal(allSummary.failed, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cooldown registry marks accounts and rotation bypasses cooling-down accounts', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cooldown-test-'));

  try {
    const token1 = {
      token: { access_token: 't1', refresh_token: 'r1', expiry: Date.now() + 100000 },
    };
    const token2 = {
      token: { access_token: 't2', refresh_token: 'r2', expiry: Date.now() + 100000 },
    };
    const token3 = {
      token: { access_token: 't3', refresh_token: 'r3', expiry: Date.now() + 100000 },
    };

    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_a1'), JSON.stringify(token1));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_a2'), JSON.stringify(token2));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_a3'), JSON.stringify(token3));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token'), JSON.stringify(token1));

    const manager = new AntigravityAuthManager(tempDir);

    // Mark a2 as cooling down
    manager.markCooldown('a2', 10000);
    assert.equal(manager.isCooldown('a2'), true);
    assert.ok(manager.getCooldownRemainingSec('a2') > 0);

    const candidates = await manager.listCandidates();
    const a2Candidate = candidates.find((c) => c.name === 'a2');
    assert.equal(a2Candidate?.isCooldown, true);

    // Rotating from a1: since a2 is in cooldown, rotation should choose a3
    const rotateRes = await manager.rotateNextCandidate('a1');
    assert.equal(rotateRes.account.name, 'a3');

    // Clear cooldown
    manager.clearCooldown('a2');
    assert.equal(manager.isCooldown('a2'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('ensureActiveTokenFresh triggers refresh only when token is near expiry', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-fresh-test-'));

  try {
    let refreshed = false;
    const mockFetch = async () => {
      refreshed = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-token',
          expires_in: 3600,
        }),
      } as unknown as Response;
    };

    // Case 1: Fresh token (expires in 2 hours)
    const freshToken = {
      token: {
        access_token: 'fresh-acc',
        refresh_token: 'r1',
        expiry: new Date(Date.now() + 7200 * 1000).toISOString(),
      },
    };
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token'), JSON.stringify(freshToken));

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch as typeof fetch);
    const didRefresh1 = await manager.ensureActiveTokenFresh(300);
    assert.equal(didRefresh1, false);
    assert.equal(refreshed, false);

    // Case 2: Expiring token (expires in 2 minutes)
    const expiringToken = {
      token: {
        access_token: 'expiring-acc',
        refresh_token: 'r1',
        expiry: new Date(Date.now() + 120 * 1000).toISOString(),
      },
    };
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token'), JSON.stringify(expiringToken));

    const didRefresh2 = await manager.ensureActiveTokenFresh(300);
    assert.equal(didRefresh2, true);
    assert.equal(refreshed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('importAccountFromJson validates credentials and creates new candidate', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-import-test-'));

  try {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'imported-access-token',
        expires_in: 3600,
      }),
    } as unknown as Response);

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch as typeof fetch);

    // Import with email in id_token
    const rawPayload = JSON.stringify({
      id_token: makeMockJwt({ email: 'imported.user@gmail.com' }),
      token: {
        refresh_token: 'imported-ref-token',
      },
    });

    const res = await manager.importAccountFromJson(rawPayload);
    assert.equal(res.success, true);
    assert.ok(res.account);
    assert.equal(res.account?.email, 'imported.user@gmail.com');

    // Candidate should now be in the list
    const candidates = await manager.listCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.email, 'imported.user@gmail.com');

    // Negative case: missing refresh_token
    const invalidPayload = JSON.stringify({
      token: { access_token: 'no-refresh-token' },
    });
    const failRes = await manager.importAccountFromJson(invalidPayload);
    assert.equal(failRes.success, false);
    assert.ok(failRes.error?.includes('Missing refresh_token'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('startBrowserLogin and completeBrowserLogin perform PKCE OAuth and persist account', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-browser-auth-test-'));

  try {
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'browser-access-token',
            refresh_token: 'browser-refresh-token',
            id_token: makeMockJwt({ email: 'telegram.browser@gmail.com' }),
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    }) as typeof fetch;

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch);

    assert.equal(manager.hasPendingLogin('chat-123'), false);

    // 1. Start browser login
    const session = manager.startBrowserLogin('chat-123');
    assert.ok(session.authUrl.startsWith('https://accounts.google.com/o/oauth2/auth'));
    assert.ok(session.authUrl.includes('code_challenge='));
    assert.equal(manager.hasPendingLogin('chat-123'), true);

    // 2. Complete browser login with redirected URL or code
    const callbackUrl = 'https://antigravity.google/oauth-callback/?code=4/0AeanS-mock-code&state=xyz';
    const result = await manager.completeBrowserLogin('chat-123', callbackUrl);

    assert.equal(result.success, true);
    assert.ok(result.account);
    assert.equal(result.account?.email, 'telegram.browser@gmail.com');
    assert.equal(manager.hasPendingLogin('chat-123'), false);

    // Verify candidate is listed and saved on disk
    const candidates = await manager.listCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.email, 'telegram.browser@gmail.com');

    // 3. Test cancel flow
    manager.startBrowserLogin('chat-456');
    assert.equal(manager.hasPendingLogin('chat-456'), true);
    manager.cancelBrowserLogin('chat-456');
    assert.equal(manager.hasPendingLogin('chat-456'), false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('switchAccount performs JIT refresh if target account token is expired', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-jit-switch-test-'));

  try {
    let refreshCalls: string[] = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body || '');
      refreshCalls.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-switched-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch);

    // Write an active fresh token
    const activeToken = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'active@gmail.com' }),
      token: {
        access_token: 'active-token',
        refresh_token: 'active-ref',
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    };
    // Write an expired standby token
    const standbyToken = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'standby@gmail.com' }),
      token: {
        access_token: 'expired-token',
        refresh_token: 'standby-ref',
        expiry: '2020-01-01T00:00:00.000Z',
      },
    };

    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_active'), JSON.stringify(activeToken, null, 2));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_standby'), JSON.stringify(standbyToken, null, 2));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token'), JSON.stringify(activeToken, null, 2));

    assert.equal(refreshCalls.length, 0);

    // Switch to standby -> should trigger JIT refresh
    const switchRes = await manager.switchAccount('standby');
    assert.equal(switchRes.success, true);
    assert.equal(refreshCalls.length, 1);
    assert.ok(refreshCalls[0]?.includes('refresh_token=standby-ref'));

    const newActive = JSON.parse(await fs.readFile(path.join(tempDir, 'antigravity-oauth-token'), 'utf8'));
    assert.equal(newActive.token.access_token, 'fresh-switched-token');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('runKeepAliveCheck refreshes only the active account and ignores standby candidates', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-selective-keepalive-test-'));

  try {
    let refreshTokensCalled: string[] = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body || '');
      refreshTokensCalled.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch);

    // Active account expiring in 5 minutes
    const activeToken = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'active@gmail.com' }),
      token: {
        access_token: 'active-expiring',
        refresh_token: 'active-ref',
        expiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    // Standby candidate expired
    const standbyToken = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'standby@gmail.com' }),
      token: {
        access_token: 'standby-expired',
        refresh_token: 'standby-ref',
        expiry: '2020-01-01T00:00:00.000Z',
      },
    };

    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_active'), JSON.stringify(activeToken, null, 2));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token_standby'), JSON.stringify(standbyToken, null, 2));
    await fs.writeFile(path.join(tempDir, 'antigravity-oauth-token'), JSON.stringify(activeToken, null, 2));

    await manager.runKeepAliveCheck();

    // Should ONLY have called refresh for active-ref, NEVER for standby-ref
    assert.equal(refreshTokensCalled.length, 1);
    assert.ok(refreshTokensCalled[0]?.includes('refresh_token=active-ref'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AntigravityAuthManager fetchQuotaForAccount fetches and caches 5h/7d quota', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-quota-test-'));

  try {
    const mockFetch: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('retrieveUserQuotaSummary')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    displayName: 'Weekly Limit Remaining',
                    window: 'weekly',
                    resetTime: '2026-09-29T08:42:18Z',
                    remainingFraction: 0.77,
                  },
                  {
                    bucketId: 'gemini-5h',
                    displayName: 'Five Hour Limit Remaining',
                    window: '5h',
                    resetTime: '2026-09-24T17:39:56Z',
                    remainingFraction: 0.28,
                  },
                ],
              },
              {
                displayName: 'Claude and GPT models',
                buckets: [
                  {
                    bucketId: '3p-weekly',
                    window: 'weekly',
                    remainingFraction: 1,
                  },
                  {
                    bucketId: '3p-5h',
                    window: '5h',
                    remainingFraction: 0.95,
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const manager = new AntigravityAuthManager(tempDir, undefined, mockFetch);

    const token = {
      auth_method: 'consumer',
      id_token: makeMockJwt({ email: 'developer@gmail.com' }),
      token: {
        access_token: 'valid-acc-token',
        refresh_token: 'some-ref-token',
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    };

    await fs.writeFile(
      path.join(tempDir, 'antigravity-oauth-token_developer'),
      JSON.stringify(token, null, 2),
    );

    const quota = await manager.fetchQuotaForAccount('developer');
    assert.ok(quota);
    assert.equal(quota.fiveHourPercent, 28);
    assert.equal(quota.weeklyPercent, 77);
    assert.equal(quota.thirdParty5hPercent, 95);
    assert.equal(quota.thirdPartyWeeklyPercent, 100);
    assert.equal(quota.resetTime5h, '2026-09-24T17:39:56Z');
    assert.equal(quota.resetTimeWeekly, '2026-09-29T08:42:18Z');

    // Test listCandidates(true) populates quota
    const candidates = await manager.listCandidates(true);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.quota?.fiveHourPercent, 28);
    assert.equal(candidates[0]?.quota?.weeklyPercent, 77);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});



