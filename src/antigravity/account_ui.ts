import { AGY_AUTH_CALLBACK_PREFIX, AGY_EFFORT_CALLBACK_PREFIX } from './ui_callbacks.js';
import type { AppLocale } from '../types.js';
import { type InlineKeyboard } from '../channels/telegram/telegram_messaging_port.js';
import { formatQuotaResetTime, type AntigravityAccount } from './auth.js';
import type { AppConfig } from '../config.js';
import type { BridgeStore } from '../store/database.js';
import type { Logger } from '../logger.js';
import type { BackendUiHost } from '../core/backend_ui.js';
import type { IEngineAdapter } from '../core/engine_spi.js';

import type { AntigravityAuthManager } from './auth.js';
interface PanelUi { sendMessage: BackendUiHost['sendMessage']; editMessage: BackendUiHost['editMessage']; scheduleStalePanelDeletion: BackendUiHost['scheduleStalePanelDeletion']; }
interface ExecutionView { syncCurrentBackendSettings(scopeId: string): void; hasActiveTurn(scopeId: string): boolean; getAdapterForScope(scopeId: string): IEngineAdapter; }

export function formatCandidateButtonPrefix(c: AntigravityAccount): string {
  const p5h = typeof c.quota?.fiveHourPercent === 'number' ? `${c.quota.fiveHourPercent}%` : '—';
  const pw = typeof c.quota?.weeklyPercent === 'number' ? `${c.quota.weeklyPercent}%` : '—';
  return `${p5h}|${pw}`;
}

export function formatCandidateDisplayName(c: AntigravityAccount): string {
  if (c.email) {
    return c.email.replace(/@gmail\.com$/i, '');
  }
  return c.name.replace(/^antigravity-oauth-token_/, '');
}

export function formatAccountExpiry(expiryMs: number | null, locale: AppLocale, isActive = false): string {
  if (!expiryMs) return locale === 'zh' ? '未知' : 'unknown';
  const now = Date.now();
  if (expiryMs <= now) {
    if (isActive) {
      return locale === 'zh' ? '待命中 (发任务时即时刷新)' : 'standby (refreshes on task)';
    }
    return locale === 'zh' ? '待命中 (就绪 · 切号时即时激活)' : 'standby (ready · refreshes on switch)';
  }
  const remainingMins = Math.round((expiryMs - now) / 60000);
  const timeStr = new Date(expiryMs).toTimeString().slice(0, 5);
  return locale === 'zh'
    ? `${timeStr} (剩 ${remainingMins} 分钟)`
    : `${timeStr} (${remainingMins}m left)`;
}
export class AntigravityAccountUi {

  constructor(private readonly config: AppConfig, private readonly store: BridgeStore, private readonly logger: Logger, private readonly auth: AntigravityAuthManager, private readonly ui: PanelUi, private readonly orchestrator: ExecutionView) {}

  async sendAuthMenu(
    scopeId: string,
    args: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const trimmedArgs = (args || '').trim();
    let currentFilter: 'all' | 'enabled' | 'attention' = 'all';

    if (trimmedArgs.startsWith('filter:')) {
      const f = trimmedArgs.slice('filter:'.length).toLowerCase();
      if (f === 'enabled' || f === 'attention' || f === 'all') {
        currentFilter = f;
      }
    } else if (trimmedArgs) {
      if (trimmedArgs.startsWith('pause ')) {
        const target = trimmedArgs.slice('pause '.length).trim();
        this.auth.pauseAccount(target);
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh' ? `⏸ 账号 \`${target}\` 已暂停使用。` : `⏸ Account \`${target}\` paused.`,
        );
        return;
      }

      if (trimmedArgs.startsWith('resume ')) {
        const target = trimmedArgs.slice('resume '.length).trim();
        this.auth.resumeAccount(target);
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh' ? `▶️ 账号 \`${target}\` 已恢复启用。` : `▶️ Account \`${target}\` resumed.`,
        );
        return;
      }

      if (trimmedArgs === 'repair_all' || trimmedArgs === 'repair all') {
        const res = await this.auth.diagnoseAndRepairAll();
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh'
            ? `🩺 **账号池体检与修复结果**\n\n• 总账号数: ${res.total}\n• 正常/已修复: ${res.healthy + res.repaired}\n• 需关注/失败: ${res.failed}\n\n${res.summary.join('\n')}`
            : `🩺 **Account Diagnostics & Repair**\n\n• Total: ${res.total}\n• Healthy/Repaired: ${res.healthy + res.repaired}\n• Failed: ${res.failed}\n\n${res.summary.join('\n')}`,
        );
        return;
      }

      if (trimmedArgs.startsWith('repair ') || trimmedArgs === 'repair') {
        const target = trimmedArgs === 'repair' ? 'active' : trimmedArgs.slice('repair '.length).trim();
        const res = await this.auth.diagnoseAndRepairAccount(target);
        await this.ui.sendMessage(
          scopeId,
          res.ok
            ? (locale === 'zh' ? `🩺 账号 \`${res.email || res.accountName}\` 检查修复成功：${res.message}` : `🩺 Account \`${res.email || res.accountName}\` repaired: ${res.message}`)
            : (locale === 'zh' ? `❌ 检查修复失败：${res.message}` : `❌ Repair failed: ${res.message}`),
        );
        return;
      }

      if (trimmedArgs === 'rotate') {
        try {
          const res = await this.auth.rotateNextCandidate();
          await this.ui.sendMessage(
            scopeId,
            locale === 'zh'
              ? `🔄 已成功轮转到下一个账号: \`${res.account.email ?? res.account.name}\``
              : `🔄 Successfully rotated to next account: \`${res.account.email ?? res.account.name}\``,
          );
        } catch (err) {
          await this.ui.sendMessage(scopeId, `❌ ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      if (trimmedArgs === 'refresh') {
        const active = await this.auth.getActiveAccount();
        if (!active) {
          await this.ui.sendMessage(scopeId, locale === 'zh' ? '❌ 当前无活跃账号。' : '❌ No active account.');
          return;
        }
        const res = await this.auth.refreshTokenForAccount(active.name);
        if (res.success) {
          await this.ui.sendMessage(
            scopeId,
            locale === 'zh'
              ? `⚡ 账号 \`${active.email || active.name}\` Token 刷新成功！`
              : `⚡ Account \`${active.email || active.name}\` refreshed successfully!`,
          );
        } else {
          await this.ui.sendMessage(scopeId, `❌ 刷新失败: ${res.error}`);
        }
        return;
      }

      if (trimmedArgs === 'refresh all' || trimmedArgs === 'refresh_all') {
        const res = await this.auth.refreshAllTokens();
        await this.auth.populateQuotas(await this.auth.listCandidates(false), true);
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh'
            ? `⚡ 全部 Token 与额度已刷新完成: 成功 ${res.refreshed} / 共 ${res.total} 个${res.failed > 0 ? ` (失败 ${res.failed})` : ''}`
            : `⚡ All tokens and quotas refreshed: ${res.refreshed} / ${res.total} succeeded`,
        );
        return;
      }

      if (trimmedArgs.startsWith('add ') || trimmedArgs.startsWith('{')) {
        const jsonContent = trimmedArgs.startsWith('add ') ? trimmedArgs.slice('add '.length).trim() : trimmedArgs;
        const res = await this.auth.importAccountFromJson(jsonContent);
        if (res.success && res.account) {
          const candidates = await this.auth.listCandidates();
          await this.ui.sendMessage(
            scopeId,
            locale === 'zh'
              ? `🎉 **Antigravity 账号导入成功！**\n• 账号名称: \`${res.account.name}\`\n• 绑定邮箱: \`${res.account.email || '未知'}\`\n• 候选池总数: 共 ${candidates.length} 个账号`
              : `🎉 **Account Imported!**\n• Name: \`${res.account.name}\`\n• Email: \`${res.account.email || 'unknown'}\`\n• Pool: ${candidates.length} accounts`,
          );
        } else {
          await this.ui.sendMessage(scopeId, `❌ 导入失败: ${res.error || '未知错误'}`);
        }
        return;
      }

      // Direct switch
      try {
        const res = await this.auth.switchAccount(trimmedArgs);
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh'
            ? `✅ 已成功切换到账号: \`${res.account.email ?? res.account.name}\``
            : `✅ Successfully switched to account: \`${res.account.email ?? res.account.name}\``,
        );
        return;
      } catch (err) {
        await this.ui.sendMessage(scopeId, `❌ ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const candidates = await this.auth.listCandidates(true);
    const active = candidates.find((c) => c.isActive) || candidates[0];

    const filtered = candidates.filter((c) => {
      if (currentFilter === 'enabled') {
        return !c.isPaused && !c.isCooldown && c.hasRefreshToken;
      }
      if (currentFilter === 'attention') {
        return c.isPaused || c.isCooldown || !c.hasRefreshToken;
      }
      return true;
    });

    const keyboard: InlineKeyboard = [];
    for (const c of filtered) {
      const prefix = formatCandidateButtonPrefix(c);
      let icon = '🔐 ';
      if (c.isPaused) {
        icon = '⏸ ';
      } else if (c.isActive) {
        icon = '🟢 ';
      } else if (c.isCooldown) {
        icon = '⏳ ';
      }
      const label = `${icon}${prefix}|${formatCandidateDisplayName(c)}${c.isPaused ? ' · off' : ''}`;

      let rightBtnText = '⏸';
      let rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      if (!c.hasRefreshToken || c.isCooldown) {
        rightBtnText = '🩺';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}repair:${c.name}`;
      } else if (c.isPaused) {
        rightBtnText = '▶️';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      } else if (c.isActive) {
        rightBtnText = '✅';
        rightBtnAction = `${AGY_AUTH_CALLBACK_PREFIX}toggle_pause:${c.name}`;
      }

      keyboard.push([
        {
          text: label.length > 28 ? `${label.slice(0, 27)}…` : label,
          callback_data: `${AGY_AUTH_CALLBACK_PREFIX}switch:${c.name}`,
        },
        {
          text: rightBtnText,
          callback_data: rightBtnAction,
        },
      ]);
    }

    // Filter tab row matching Codex
    keyboard.push([
      {
        text: currentFilter === 'all' ? '☑️ 全部' : '全部',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:all`,
      },
      {
        text: currentFilter === 'enabled' ? '☑️ 已启用' : '已启用',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:enabled`,
      },
      {
        text: currentFilter === 'attention' ? '☑️ 需关注' : '需关注',
        callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:attention`,
      },
    ]);

    keyboard.push([
      { text: '🔑 设备登录', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}login` },
      { text: '🩺 账号体检与修复', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}repair_all` },
    ]);

    keyboard.push([
      { text: '🔄 轮转切号', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}rotate` },
      { text: '⚡ 刷新额度与Token', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}refresh_all` },
    ]);

    keyboard.push([
      { text: '📥 账号导入指南', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}import_help` },
      { text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' },
    ]);

    const activeExpiry = formatAccountExpiry(active?.expiry ?? null, locale, true);
    const activeLabel = active ? `${active.email || active.name}` : locale === 'zh' ? '无' : 'None';

    let quotaDetails = '';
    if (active?.quota) {
      const q = active.quota;
      const p5h = typeof q.fiveHourPercent === 'number' ? `${q.fiveHourPercent}%` : '未知';
      const pw = typeof q.weeklyPercent === 'number' ? `${q.weeklyPercent}%` : '未知';
      const r5h = q.resetTime5h ? formatQuotaResetTime(q.resetTime5h) : '—';
      const rw = q.resetTimeWeekly ? formatQuotaResetTime(q.resetTimeWeekly) : '—';

      quotaDetails =
        locale === 'zh'
          ? `\n• **Gemini 5h 额度**: \`${p5h}\` (重置于 ${r5h})` +
            `\n• **Gemini 7d 额度**: \`${pw}\` (重置于 ${rw})`
          : `\n• **Gemini 5h Quota**: \`${p5h}\` (resets ${r5h})` +
            `\n• **Gemini 7d Quota**: \`${pw}\` (resets ${rw})`;

      if (typeof q.thirdPartyWeeklyPercent === 'number') {
        const p3pw = `${q.thirdPartyWeeklyPercent}%`;
        const r3pw = q.resetTimeWeekly ? formatQuotaResetTime(q.resetTimeWeekly) : '—';
        quotaDetails +=
          locale === 'zh'
            ? `\n• **3P (Claude/GPT)**: \`${p3pw}\` (重置于 ${r3pw})`
            : `\n• **3P (Claude/GPT)**: \`${p3pw}\` (resets ${r3pw})`;
      }
    } else {
      quotaDetails =
        locale === 'zh'
          ? `\n• **5h/7d 额度**: \`未获取到\` (点击【⚡ 刷新额度与Token】实时获取)`
          : `\n• **5h/7d Quota**: \`Not available\` (tap [⚡ Refresh Quota & Token])`;
    }

    const text =
      locale === 'zh'
        ? `👤 **Antigravity 账号管理池**\n\n` +
          `• **当前活跃账号**: \`${activeLabel}\`\n` +
          `• **活跃 Token 状态**: ${activeExpiry}` +
          quotaDetails +
          `\n• **账号池总数**: 共 ${candidates.length} 个账号\n` +
          `• **按键前缀说明**: \`5h剩余% | 7d剩余% | 账号别名\` (数值为剩余额度百分比，非时间)\n\n` +
          `点击下方账号名称可即时无缝热切换；点击【🔑 设备登录】可在 Telegram 内直接授权绑定新账号。`
        : `👤 **Antigravity Account Pool**\n\n` +
          `• **Active**: \`${activeLabel}\`\n` +
          `• **Status**: ${activeExpiry}` +
          quotaDetails +
          `\n• **Pool Size**: ${candidates.length} accounts\n` +
          `• **Prefix Meaning**: \`5h% | 7d% | account\` (values represent remaining quota %, not time)\n\n` +
          `Tap candidate below to switch seamlessly. Tap [🔑 Device Login] to sign in.`;

    if (editMessageId) {
      await this.ui.editMessage(scopeId, editMessageId, text, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.ui.sendMessage(scopeId, text, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }

  async startLoginFlow(scopeId: string, locale: AppLocale, editMessageId?: number): Promise<void> {
    const session = this.auth.startBrowserLogin(scopeId);

    const keyboard: InlineKeyboard = [
      [{ text: '❌ 取消登录会话', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}cancel_login` }],
      [{ text: '◀️ 返回账号列表', callback_data: `${AGY_AUTH_CALLBACK_PREFIX}filter:all` }],
    ];

    const text =
      locale === 'zh'
        ? `🔑 **Google / Antigravity 设备授权登录**\n\n` +
          `1️⃣ **点击授权链接**（在浏览器中打开）：\n` +
          `[👉 点击打开 Google 授权登录页面](${session.authUrl})\n\n` +
          `2️⃣ 在浏览器中完成账号选择与权限授予；\n` +
          `3️⃣ 授权完成后，浏览器页面可能提示复制授权码（Authorization Code），或重定向至空白页；\n` +
          `4️⃣ 直接将**授权码**或**重定向完整 URL**复制并作为消息发送给本机器人即可！\n\n` +
          `*临时会话有效期 10 分钟。随时发送 \`/auth cancel\` 可取消。*`
        : `🔑 **Google / Antigravity OAuth Login**\n\n` +
          `1️⃣ **Click authorization link**:\n` +
          `[👉 Open Google Authorization](${session.authUrl})\n\n` +
          `2️⃣ Approve requested permissions;\n` +
          `3️⃣ Paste the authorization code or redirect URL back into this chat!\n\n` +
          `*Valid for 10 minutes. Send /auth cancel to abort.*`;

    if (editMessageId) {
      await this.ui.editMessage(scopeId, editMessageId, text, keyboard);
    } else {
      await this.ui.sendMessage(scopeId, text, keyboard);
    }
  }

  async sendEffortMenu(
    scopeId: string,
    arg: string,
    locale: AppLocale,
    editMessageId?: number,
  ): Promise<void> {
    const settings = this.store.getChatSettings(scopeId);
    const isBoost = settings?.serviceTier === 'boost';

    if (arg) {
      const target = arg.toLowerCase();
      if (target === 'low' || target === 'medium' || target === 'high') {
        if (target !== 'high' && isBoost) {
          this.store.setChatServiceTier(scopeId, null);
        }
        this.store.setChatEffort(scopeId, target);
        this.orchestrator.syncCurrentBackendSettings(scopeId);
        await this.ui.sendMessage(
          scopeId,
          locale === 'zh' ? `✅ 思考深度已切换为: \`${target}\`` : `✅ Effort switched to: \`${target}\``,
        );
        return;
      }
    }

    const current = isBoost ? 'high' : (settings?.reasoningEffort ?? 'high');

    const keyboard: InlineKeyboard = [
      [
        {
          text: `${current === 'low' ? '✅ ' : ''}Low (快速)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}low`,
        },
        {
          text: `${current === 'medium' ? '✅ ' : ''}Medium (平衡)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}medium`,
        },
        {
          text: `${current === 'high' ? '✅ ' : ''}High (深度思考)`,
          callback_data: `${AGY_EFFORT_CALLBACK_PREFIX}high`,
        },
      ],
      [{ text: '◀️ 返回控制面板', callback_data: 'engine:setup:main' }],
    ];

    const boostHint = isBoost
      ? locale === 'zh'
        ? '\n\n*(当前处于 Boost 模式，深度锁定为 High)*'
        : '\n\n*(Locked to High in Boost Mode)*'
      : '';

    const text =
      locale === 'zh'
        ? `⚡ **选择思考深度 (Reasoning Effort)**\n当前深度: \`${current}\`${boostHint}`
        : `⚡ **Select Reasoning Effort**\nCurrent: \`${current}\`${boostHint}`;

    if (editMessageId) {
      await this.ui.editMessage(scopeId, editMessageId, text, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, editMessageId);
    } else {
      const msgId = await this.ui.sendMessage(scopeId, text, keyboard);
      this.ui.scheduleStalePanelDeletion(scopeId, msgId);
    }
  }
}
