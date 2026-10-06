import type {
  AppLocale,
  CodexAppInfo,
  CodexConfigRequirements,
  CodexExperimentalFeature,
  CodexFuzzyFileResult,
  CodexHooksListEntry,
  CodexMcpResourceContent,
  CodexMcpServerStatus,
  CodexModelProviderCapabilities,
  CodexPluginDetail,
  CodexPluginMarketplace,
  CodexSkillMetadata,
  CodexSkillsListEntry,
  CodexThreadGoal,
  AppTurnSnapshot,
  ThreadGoalStatusValue,
} from '../types.js';
import { t } from '../i18n.js';
import { escapeTelegramHtml, telegramBold, telegramDetails, telegramExpandableBlockquote, telegramPreCode } from '../telegram/html.js';
import { TELEGRAM_RICH_MESSAGE_TEXT_LIMIT } from '../telegram/rich.js';
import type { SelfUpdateStatus } from '../update.js';
import type { AppConfig } from '../config.js';
import type { CodexAuthPoolStats } from '../store/database.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { truncateInline } from './turn_rendering.js';
import {
  RichAuthCandidateRow,
  CODEX_AUTH_STALE_CREDENTIAL_DAYS,
  SelfUpdateBroadcastSummary,
  AUTH_DELETE_REASON_NEEDS_REPAIR,
  RemoteControlStatusState,
} from './state_types.js';
import { formatConfigValue, formatTokenCount, formatCompactNumber, formatLocalTimestamp, summarizeTurnItems } from './shared_helpers.js';

export function findSkill(entries: CodexSkillsListEntry[], name: string): CodexSkillMetadata | null {
  const normalized = name.trim().toLowerCase();
  for (const entry of entries) {
    const skill = entry.skills.find(candidate =>
      candidate.name.toLowerCase() === normalized
      || candidate.displayName?.toLowerCase() === normalized);
    if (skill) return skill;
  }
  return null;
}

export function formatSkillsMessage(locale: AppLocale, entries: CodexSkillsListEntry[], query: string | null, forceReload: boolean): string {
  const skills = entries.flatMap(entry => entry.skills.map(skill => ({ cwd: entry.cwd, skill })))
    .filter(entry => !query
      || entry.skill.name.toLowerCase().includes(query.toLowerCase())
      || entry.skill.description.toLowerCase().includes(query.toLowerCase()));
  const lines = [
    t(locale, 'skills_title'),
    forceReload ? t(locale, 'skills_reloaded') : null,
    query ? t(locale, 'skills_filter', { value: query }) : null,
  ].filter((line): line is string => Boolean(line));
  if (skills.length === 0) {
    lines.push(t(locale, 'skills_empty'));
  } else {
    for (const { skill } of skills.slice(0, 30)) {
      const enabled = skill.enabled ? 'on' : 'off';
      const label = skill.displayName || skill.name;
      lines.push(`${skill.enabled ? '*' : '-'} ${label} (${enabled})`);
      const desc = skill.shortDescription || skill.description;
      if (desc) {
        lines.push(`  ${truncateInline(desc, 120)}`);
      }
    }
    if (skills.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: skills.length - 30 }));
    }
  }
  const errors = entries.flatMap(entry => entry.errors);
  if (errors.length > 0) {
    lines.push('', t(locale, 'skills_errors'));
    lines.push(...errors.slice(0, 5).map(error => `- ${truncateInline(error, 160)}`));
  }
  return lines.join('\n');
}

export function formatSkillDetailMessage(locale: AppLocale, skill: CodexSkillMetadata): string {
  return [
    t(locale, 'skill_title', { name: skill.displayName || skill.name }),
    t(locale, 'skill_name', { value: skill.name }),
    t(locale, 'skill_enabled_state', { value: skill.enabled ? t(locale, 'yes') : t(locale, 'no') }),
    t(locale, 'skill_scope', { value: skill.scope || t(locale, 'unknown') }),
    t(locale, 'skill_path', { value: skill.path || t(locale, 'unknown') }),
    '',
    skill.description || skill.shortDescription || t(locale, 'empty'),
    skill.defaultPrompt ? `\n${t(locale, 'skill_default_prompt', { value: skill.defaultPrompt })}` : '',
  ].filter(Boolean).join('\n');
}

export function formatMcpStatusMessage(locale: AppLocale, statuses: CodexMcpServerStatus[]): string {
  const lines = [t(locale, 'mcp_title')];
  if (statuses.length === 0) {
    lines.push(t(locale, 'mcp_empty'));
    return lines.join('\n');
  }
  for (const status of statuses) {
    lines.push(`${status.name}: ${status.authStatus}`);
    lines.push(`  tools: ${status.toolNames.length ? status.toolNames.slice(0, 12).join(', ') : '-'}`);
    if (status.resourceUris.length > 0) {
      lines.push(`  resources: ${status.resourceUris.slice(0, 5).join(', ')}`);
    }
    if (status.resourceTemplateUris.length > 0) {
      lines.push(`  templates: ${status.resourceTemplateUris.slice(0, 5).join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function formatMcpResourceMessage(
  locale: AppLocale,
  server: string,
  uri: string,
  contents: CodexMcpResourceContent[],
): string {
  const lines = [t(locale, 'mcp_resource_title', { server, uri })];
  if (contents.length === 0) {
    lines.push(t(locale, 'mcp_resource_empty'));
    return lines.join('\n');
  }
  for (const content of contents.slice(0, 5)) {
    lines.push(`- ${content.type}${content.mimeType ? ` (${content.mimeType})` : ''}${content.uri ? ` ${content.uri}` : ''}`);
    if (content.text) {
      lines.push(truncateInline(content.text, 1500));
    } else if (content.blob) {
      lines.push(t(locale, 'mcp_resource_blob', { size: content.blob.length }));
    }
  }
  return lines.join('\n');
}

export function formatDiffMessage(locale: AppLocale, diff: string): string {
  const clipped = diff.length > 3500 ? `${diff.slice(0, 3500)}\n...` : diff;
  return [
    telegramBold(t(locale, 'diff_title')),
    telegramExpandableBlockquote(clipped),
  ].join('\n');
}

export function formatRichDiffMessage(locale: AppLocale, diff: string): string {
  const clipped = clipRichMessageText(diff, Math.min(24_000, TELEGRAM_RICH_MESSAGE_TEXT_LIMIT - 1024));
  const summary = locale === 'zh' ? '展开 diff' : 'Expand diff';
  const footer = locale === 'zh'
    ? 'FoxClaw · sendRichMessage · details/pre/code'
    : 'FoxClaw · sendRichMessage · details/pre/code';
  return [
    `<h3>${escapeTelegramHtml(t(locale, 'diff_title'))}</h3>`,
    telegramDetails(summary, telegramPreCode(clipped, 'diff')),
    `<footer>${escapeTelegramHtml(footer)}</footer>`,
  ].join('\n');
}

export function formatRichDemoMessage(locale: AppLocale): string {
  const title = 'FoxClaw RichMessage';
  const intro = locale === 'zh'
    ? '这条消息通过 Telegram Bot API sendRichMessage 发送，用来验证 Rich Message 在真实客户端里的渲染。'
    : 'This message is sent through Telegram Bot API sendRichMessage to verify Rich Message rendering in a real client.';
  const detailsSummary = locale === 'zh' ? '展开 details + pre 示例' : 'Open details + pre sample';
  const diffSample = [
    'diff --git a/src/telegram/rich.ts b/src/telegram/rich.ts',
    '+ sendRichMessage({ rich_message: { html } })',
    '+ <details><summary>Expandable</summary>...</details>',
    '+ <table bordered striped>...</table>',
  ].join('\n');
  const tableCaption = locale === 'zh' ? 'FoxClaw 可用 rich 面' : 'FoxClaw rich surfaces';
  const surfaceHeader = locale === 'zh' ? '功能面' : 'Surface';
  const richHeader = locale === 'zh' ? 'Rich 用法' : 'Rich usage';
  const tableRows: Array<[string, string]> = locale === 'zh'
    ? [
        ['`/diff`', 'details + pre/code'],
        ['工具状态', 'details/list'],
        ['`/status`', 'table'],
      ]
    : [
        ['`/diff`', 'details + pre/code'],
        ['Tool status', 'details/list'],
        ['`/status`', 'table'],
      ];
  const listItems = locale === 'zh'
    ? ['Gateway 已接入 sendRichMessage', '/diff 已优先使用 RichMessage', '失败会回退到 Telegram HTML']
    : ['Gateway now supports sendRichMessage', '/diff prefers RichMessage', 'Failures fall back to Telegram HTML'];
  const detailBody = [
    `<p>${escapeTelegramHtml(locale === 'zh' ? '下面是 rich pre/code block，客户端支持时会按代码块渲染。' : 'This is a rich pre/code block rendered as code by supported clients.')}</p>`,
    telegramPreCode(diffSample, 'diff'),
  ].join('\n');
  return [
    `<h2>${escapeTelegramHtml(title)}</h2>`,
    `<p><b>Bot API 10.1</b> ${escapeTelegramHtml(intro)}</p>`,
    '<hr/>',
    '<table bordered striped>',
    `<caption>${escapeTelegramHtml(tableCaption)}</caption>`,
    `<tr><th>${escapeTelegramHtml(surfaceHeader)}</th><th>${escapeTelegramHtml(richHeader)}</th></tr>`,
    ...tableRows.map(([surface, usage]) => `<tr><td>${escapeTelegramHtml(surface)}</td><td>${escapeTelegramHtml(usage)}</td></tr>`),
    '</table>',
    telegramDetails(detailsSummary, detailBody, true),
    '<ul>',
    ...listItems.map(item => `<li>${escapeTelegramHtml(item)}</li>`),
    '</ul>',
    '<footer>FoxClaw · sendRichMessage</footer>',
  ].join('\n');
}

export function formatRichDemoFallbackMessage(locale: AppLocale): string {
  const lines = locale === 'zh'
    ? [
        'RichMessage fallback 预览',
        'Gateway 已接入 sendRichMessage',
        '/diff 已优先使用 RichMessage',
        '如果你看到这条 HTML fallback，说明 Telegram rich API 返回了失败，正常功能仍可用。',
      ]
    : [
        'RichMessage fallback preview',
        'Gateway now supports sendRichMessage',
        '/diff prefers RichMessage',
        'If you see this HTML fallback, Telegram rich API failed but normal messaging still works.',
      ];
  return [
    telegramBold('FoxClaw RichMessage'),
    telegramExpandableBlockquote(lines.join('\n')),
    telegramPreCode('sendRichMessage({ rich_message: { html } })', 'typescript'),
  ].join('\n');
}

export function formatRichInternalMessage(title: string, text: string): string {
  const sections = splitRichInternalSections(text);
  const body = sections.map(formatRichInternalSection).filter(Boolean).join('\n');
  return [
    `<h3>${escapeTelegramHtml(title)}</h3>`,
    body || `<p>${escapeTelegramHtml(text)}</p>`,
    telegramDetails('Plain text', telegramPreCode(text, 'text')),
    '<footer>FoxClaw · RichMessage</footer>',
  ].join('\n');
}

export function splitRichInternalSections(text: string): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      if (current.length > 0) {
        sections.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current);
  }
  return sections;
}

export function formatRichInternalSection(lines: string[]): string {
  const candidateRows = lines
    .map(parseRichAuthCandidateRow)
    .filter((row): row is RichAuthCandidateRow => row !== null);
  if (candidateRows.length > 0) {
    const nonCandidateLines = lines.filter(line => parseRichAuthCandidateRow(line) === null);
    return [
      nonCandidateLines.length > 0 ? formatRichInternalSectionWithoutCandidates(nonCandidateLines) : '',
      formatRichAuthCandidateTable(candidateRows),
    ].filter(Boolean).join('\n');
  }
  return formatRichInternalSectionWithoutCandidates(lines);
}

export function formatRichInternalSectionWithoutCandidates(lines: string[]): string {
  const rows = lines
    .map(parseRichInternalKeyValue)
    .filter((row): row is [string, string] => row !== null);
  if (rows.length >= Math.max(2, Math.floor(lines.length * 0.6))) {
    return [
      '<table bordered striped>',
      ...rows.map(([key, value]) => (
        `<tr><td>${escapeTelegramHtml(key)}</td><td>${formatRichInternalValue(value)}</td></tr>`
      )),
      '</table>',
    ].join('\n');
  }
  return [
    '<ul>',
    ...lines.map(line => `<li>${formatRichInternalValue(line.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`),
    '</ul>',
  ].join('\n');
}

export function parseRichAuthCandidateRow(line: string): RichAuthCandidateRow | null {
  const match = line.match(/^\s*(\d+)\.\s+(.+)$/);
  if (!match) {
    return null;
  }
  let body = match[2]!.trim();
  let status = '';
  const statusMatch = body.match(/^(.*?)\s+(\[[^\]]+\])$/);
  if (statusMatch) {
    body = statusMatch[1]!.trim();
    status = statusMatch[2]!.replace(/^\[|\]$/g, '');
  }
  const current = body.endsWith(' *');
  if (current) {
    body = body.slice(0, -2).trimEnd();
  }
  const parts = body.split('|');
  const name = parts.pop()?.trim() ?? '';
  if (!name) {
    return null;
  }
  const quotas = parts.map(parseRichAuthQuotaCell);
  const statusParts = splitRichAuthStatus(status);
  return {
    index: match[1]!,
    quotaA: quotas[0]?.value ?? '-',
    quotaAReset: quotas[0]?.reset ?? '-',
    quotaB: quotas[1]?.value ?? '-',
    quotaBReset: quotas[1]?.reset ?? '-',
    name,
    current,
    enabled: statusParts.health === 'disabled' || statusParts.health === '已禁用'
      ? false
      : statusParts.health === '-' ? null : true,
    ...statusParts,
  };
}

export function formatRichAuthCandidateTable(rows: RichAuthCandidateRow[]): string {
  return [
    '<table bordered striped>',
    '<tr><th>#</th><th>Quota A</th><th>A reset</th><th>Quota B</th><th>B reset</th><th>Auth</th><th>Current</th><th>Plan</th><th>Health</th><th>Last refresh</th><th>Expiry</th><th>Risk</th><th>Command</th></tr>',
    ...rows.map(row => [
      '<tr>',
      `<td>${escapeTelegramHtml(row.index)}</td>`,
      `<td>${escapeTelegramHtml(row.quotaA)}</td>`,
      `<td>${escapeTelegramHtml(row.quotaAReset)}</td>`,
      `<td>${escapeTelegramHtml(row.quotaB)}</td>`,
      `<td>${escapeTelegramHtml(row.quotaBReset)}</td>`,
      `<td>${formatRichAuthCommandLink(`/auth use ${row.index}`, row.name)}</td>`,
      `<td>${row.current ? 'yes' : '-'}</td>`,
      `<td>${escapeTelegramHtml(row.plan)}</td>`,
      `<td>${escapeTelegramHtml(row.health)}</td>`,
      `<td>${escapeTelegramHtml(row.refresh)}</td>`,
      `<td>${escapeTelegramHtml(row.expiry)}</td>`,
      `<td>${escapeTelegramHtml(row.risk)}</td>`,
      `<td>${formatRichAuthCommandCell(row)}</td>`,
      '</tr>',
    ].join('')),
    '</table>',
  ].join('\n');
}

export function splitRichAuthStatus(status: string): Pick<RichAuthCandidateRow, 'plan' | 'health' | 'refresh' | 'expiry' | 'risk'> {
  const parts = status.split(' · ').map(part => part.trim()).filter(Boolean);
  const refreshIndex = parts.findIndex(part => /^(refreshed|刷新于)\b/i.test(part));
  const refresh = refreshIndex >= 0 ? parts.splice(refreshIndex, 1)[0]! : '-';
  const expiryIndex = parts.findIndex(part => /^(expires|过期于)\b/i.test(part));
  const expiry = expiryIndex >= 0 ? parts.splice(expiryIndex, 1)[0]! : '-';
  const plan = parts.length > 1 ? parts.shift()! : '-';
  const health = parts.shift() ?? '-';
  return {
    plan,
    health,
    refresh,
    expiry,
    risk: formatRichAuthRisk(health),
  };
}

export function formatRichAuthRisk(health: string): string {
  if (/not recently refreshed|长期未刷新/i.test(health)) {
    return `stale >${CODEX_AUTH_STALE_CREDENTIAL_DAYS}d`;
  }
  if (/needs login repair|需要登录修复/i.test(health)) {
    return 'repair';
  }
  if (/quota exhausted|额度耗尽/i.test(health)) {
    return 'quota exhausted';
  }
  if (/invalid|无效/i.test(health)) {
    return 'invalid';
  }
  if (/\blow\b|偏低|低/i.test(health)) {
    return 'low quota';
  }
  if (/unknown|未知/i.test(health)) {
    return 'unknown';
  }
  return '-';
}

export function parseRichAuthQuotaCell(value: string): { value: string; reset: string } {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '--' || trimmed === '—') {
    return { value: '-', reset: '-' };
  }
  const [quotaPart, reset = '-'] = trimmed.split('@', 2);
  const [windowLabel, percent] = quotaPart!.split(':');
  if (!windowLabel || percent === undefined) {
    return { value: quotaPart!, reset };
  }
  return { value: `${percent}%`, reset };
}

export function formatRichAuthCommandCell(row: RichAuthCandidateRow): string {
  const commands = [formatRichAuthCommandLink(`/auth use ${row.index}`, 'use')];
  if (row.enabled === true) {
    commands.push(formatRichAuthCommandLink(`/auth disable ${row.index}`, 'disable'));
  } else if (row.enabled === false) {
    commands.push(formatRichAuthCommandLink(`/auth enable ${row.index}`, 'enable'));
  }
  return commands.join(' ');
}

export function formatRichAuthCommandLink(command: string, label: string): string {
  const url = `tg://msg?text=${encodeURIComponent(command)}`;
  return `<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`;
}

export function parseRichInternalKeyValue(line: string): [string, string] | null {
  const separator = line.includes('：') ? '：' : ':';
  const index = line.indexOf(separator);
  if (index <= 0) {
    return null;
  }
  const key = line.slice(0, index).trim();
  const value = line.slice(index + separator.length).trim();
  if (!key || !value || key.length > 80) {
    return null;
  }
  return [key, value];
}

export function formatRichInternalValue(value: string): string {
  const escaped = escapeTelegramHtml(value);
  return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderTelegramTable(headers: string[], rows: string[][]): string {
  return [
    '<table bordered striped>',
    `<thead><tr>${headers.map(header => `<th>${escapeTelegramHtml(header)}</th>`).join('')}</tr></thead>`,
    `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeTelegramHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`,
    '</table>',
  ].join('');
}

export function formatSelfUpdateVersionTransition(
  fromVersion: string | null | undefined,
  toVersion: string | null | undefined,
  locale: AppLocale,
): string {
  if (!fromVersion && !toVersion) {
    return locale === 'zh' ? '未检测' : 'Not detected';
  }
  return `${fromVersion ?? '?'} -> ${toVersion ?? '?'}`;
}

export function formatCodexUpdateState(status: SelfUpdateStatus): string {
  if (status.codexFromVersion && status.codexToVersion) {
    if (status.codexFromVersion === status.codexToVersion) {
      return status.locale === 'zh' ? '已是最新版本' : 'Already current';
    }
    return status.locale === 'zh' ? '升级完成' : 'Updated';
  }
  return status.codexUpdate ?? (status.locale === 'zh' ? '未执行升级' : 'Not updated');
}

export function formatSelfUpdateBroadcastLine(
  locale: AppLocale,
  targetVersion: string | null,
  broadcast: SelfUpdateBroadcastSummary,
): string {
  if (broadcast.state === 'disabled') {
    return locale === 'zh' ? '未启用跨节点同步' : 'Cross-node sync is disabled';
  }
  if (broadcast.state === 'pending') {
    return locale === 'zh'
      ? `目标 ${targetVersion ?? '?'}，等待广播结果`
      : `Target ${targetVersion ?? '?'}; waiting for broadcast result`;
  }
  if (broadcast.peers.length === 0) {
    return locale === 'zh' ? '广播完成，无已配置 peer' : 'Broadcast completed; no configured peers';
  }
  return locale === 'zh'
    ? `已发送 ${broadcast.sent} 个 peer：${broadcast.peers.join('、')}`
    : `Sent to ${broadcast.sent} peers: ${broadcast.peers.join(', ')}`;
}

export function clipRichMessageText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 4))}\n...`;
}

export function formatLoadedThreadsMessage(locale: AppLocale, threadIds: string[]): string {
  const lines = [t(locale, 'loaded_title')];
  if (threadIds.length === 0) {
    lines.push(t(locale, 'loaded_empty'));
    return lines.join('\n');
  }
  for (const threadId of threadIds.slice(0, 30)) {
    lines.push(`- ${threadId}`);
  }
  if (threadIds.length > 30) {
    lines.push(t(locale, 'list_truncated', { count: threadIds.length - 30 }));
  }
  return lines.join('\n');
}

export function formatHooksMessage(locale: AppLocale, entries: CodexHooksListEntry[]): string {
  const hooks = entries.flatMap(entry => entry.hooks.map(hook => ({ cwd: entry.cwd, hook })));
  const lines = [t(locale, 'hooks_title')];
  if (hooks.length === 0) {
    lines.push(t(locale, 'hooks_empty'));
  } else {
    for (const { hook } of hooks.slice(0, 30)) {
      lines.push(`${hook.enabled ? '*' : '-'} ${hook.key} (${hook.eventName}, ${hook.trustStatus})`);
      const detail = [hook.pluginId ? `plugin=${hook.pluginId}` : null, hook.statusMessage, hook.command].filter(Boolean).join(' · ');
      if (detail) {
        lines.push(`  ${truncateInline(detail, 140)}`);
      }
    }
    if (hooks.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: hooks.length - 30 }));
    }
  }
  const warnings = entries.flatMap(entry => entry.warnings);
  const errors = entries.flatMap(entry => entry.errors);
  if (warnings.length > 0) {
    lines.push('', t(locale, 'hooks_warnings'));
    lines.push(...warnings.slice(0, 5).map(warning => `- ${truncateInline(warning, 160)}`));
  }
  if (errors.length > 0) {
    lines.push('', t(locale, 'hooks_errors'));
    lines.push(...errors.slice(0, 5).map(error => `- ${truncateInline(`${error.path}: ${error.message}`, 180)}`));
  }
  return lines.join('\n');
}

export function formatPluginsMessage(locale: AppLocale, marketplaces: CodexPluginMarketplace[], query: string | null): string {
  const plugins = marketplaces.flatMap(marketplace => marketplace.plugins.map(plugin => ({ marketplace, plugin })))
    .filter(entry => !query
      || entry.plugin.name.toLowerCase().includes(query.toLowerCase())
      || entry.plugin.id.toLowerCase().includes(query.toLowerCase()));
  const lines = [t(locale, 'plugins_title')];
  if (query) lines.push(t(locale, 'plugins_filter', { value: query }));
  if (plugins.length === 0) {
    lines.push(t(locale, 'plugins_empty'));
  } else {
    for (const { marketplace, plugin } of plugins.slice(0, 30)) {
      const state = `${plugin.installed ? 'installed' : 'not-installed'}, ${plugin.enabled ? 'on' : 'off'}`;
      lines.push(`${plugin.enabled ? '*' : '-'} ${plugin.name} (${state})`);
      lines.push(`  ${plugin.id} · ${marketplace.displayName || marketplace.name}`);
    }
    if (plugins.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: plugins.length - 30 }));
    }
  }
  return lines.join('\n');
}

export function formatPluginDetailMessage(locale: AppLocale, plugin: CodexPluginDetail): string {
  const lines = [
    t(locale, 'plugin_title', { name: plugin.summary.name || plugin.summary.id }),
    `id: ${plugin.summary.id}`,
    `marketplace: ${plugin.marketplaceName}`,
    `state: ${plugin.summary.installed ? 'installed' : 'not-installed'}, ${plugin.summary.enabled ? 'on' : 'off'}`,
    plugin.description ? truncateInline(plugin.description, 400) : null,
  ].filter((line): line is string => Boolean(line));
  if (plugin.skills.length > 0) {
    lines.push('', `skills: ${plugin.skills.slice(0, 12).map(skill => skill.name).join(', ')}`);
  }
  if (plugin.hooks.length > 0) {
    lines.push(`hooks: ${plugin.hooks.slice(0, 12).map(hook => `${hook.eventName}:${hook.key}`).join(', ')}`);
  }
  if (plugin.apps.length > 0) {
    lines.push(`apps: ${plugin.apps.slice(0, 12).map(app => app.name || app.id).join(', ')}`);
  }
  if (plugin.mcpServers.length > 0) {
    lines.push(`mcp: ${plugin.mcpServers.slice(0, 12).join(', ')}`);
  }
  return lines.join('\n');
}

export function formatPluginSkillMessage(locale: AppLocale, marketplace: string, plugin: string, skill: string, contents: string | null): string {
  const lines = [t(locale, 'plugin_skill_title', { marketplace, plugin, skill })];
  if (!contents) {
    lines.push(t(locale, 'plugin_skill_empty'));
    return lines.join('\n');
  }
  lines.push(truncateInline(contents, 3500));
  return lines.join('\n');
}

export function formatAppsMessage(locale: AppLocale, apps: CodexAppInfo[], forceRefetch: boolean): string {
  const lines = [t(locale, 'apps_title')];
  if (forceRefetch) lines.push(t(locale, 'apps_reloaded'));
  if (apps.length === 0) {
    lines.push(t(locale, 'apps_empty'));
  } else {
    for (const app of apps.slice(0, 30)) {
      const state = `${app.isEnabled ? 'on' : 'off'}, ${app.isAccessible ? 'accessible' : 'blocked'}`;
      lines.push(`${app.isEnabled ? '*' : '-'} ${app.name} (${state})`);
      if (app.description) lines.push(`  ${truncateInline(app.description, 120)}`);
    }
    if (apps.length > 30) {
      lines.push(t(locale, 'list_truncated', { count: apps.length - 30 }));
    }
  }
  return lines.join('\n');
}

export function formatFeaturesMessage(locale: AppLocale, features: CodexExperimentalFeature[]): string {
  const lines = [t(locale, 'features_title')];
  if (features.length === 0) {
    lines.push(t(locale, 'features_empty'));
    return lines.join('\n');
  }
  for (const feature of features.slice(0, 40)) {
    lines.push(`${feature.enabled ? '*' : '-'} ${feature.displayName || feature.name} (${feature.stage})`);
    if (feature.description) lines.push(`  ${truncateInline(feature.description, 120)}`);
  }
  if (features.length > 40) {
    lines.push(t(locale, 'list_truncated', { count: features.length - 40 }));
  }
  return lines.join('\n');
}

export function formatConfigMessage(
  locale: AppLocale,
  result: Record<string, unknown>,
  appConfig: AppConfig,
  authPoolStats: CodexAuthPoolStats,
): string {
  const config = result.config && typeof result.config === 'object' ? result.config as Record<string, unknown> : {};
  const layers = Array.isArray(result.layers) ? result.layers : [];
  const keys = ['model', 'model_provider', 'approval_policy', 'sandbox_mode', 'web_search', 'service_tier', 'profile', 'review_model'];
  const lines = [t(locale, 'config_title')];
  for (const key of keys) {
    const value = config[key];
    lines.push(`${key}: ${value === null || value === undefined ? '-' : formatConfigValue(value)}`);
  }
  lines.push(t(locale, 'config_layers', { count: layers.length }));
  lines.push('');
  lines.push(t(locale, 'config_foxclaw_title'));
    lines.push(t(locale, 'config_auth_auto_delete_needs_repair', {
      value: t(locale, appConfig.authAutoDeleteNeedsRepair ? 'yes' : 'no'),
    }));
    lines.push(`AUTH_AUTO_DELETE_NEEDS_REPAIR=${appConfig.authAutoDeleteNeedsRepair ? 'true' : 'false'}`);
    lines.push(t(locale, 'config_delete_tool_details_after_final', {
      value: t(locale, appConfig.telegramDeleteToolDetailsAfterFinal ? 'yes' : 'no'),
    }));
    lines.push(`TELEGRAM_DELETE_TOOL_DETAILS_AFTER_FINAL=${appConfig.telegramDeleteToolDetailsAfterFinal ? 'true' : 'false'}`);
    lines.push(t(locale, 'config_panel_ttl', { value: formatDurationMs(locale, appConfig.telegramPanelTtlMs) }));
    lines.push(`TELEGRAM_PANEL_TTL_MS=${appConfig.telegramPanelTtlMs}`);
    lines.push(formatCodexAuthPoolSummary(locale, authPoolStats));
    lines.push(...formatCodexApiProviderConfigLines(locale, appConfig));
  return lines.join('\n');
}

export function formatCodexApiProviderConfigLines(locale: AppLocale, appConfig: AppConfig): string[] {
  if (appConfig.codexApiProviders.length === 0) {
    return [t(locale, 'config_api_providers_none')];
  }
  const lines = [t(locale, 'config_api_providers_title')];
  lines.push(t(locale, 'config_api_default_provider', { value: appConfig.codexApiDefaultProvider ?? '-' }));
  for (const provider of appConfig.codexApiProviders) {
    lines.push(t(locale, 'config_api_provider_line', {
      id: provider.id,
      model: provider.model ?? '-',
      base: provider.baseUrl,
      env: provider.apiKeyEnv,
      key: process.env[provider.apiKeyEnv]?.trim() ? t(locale, 'yes') : t(locale, 'no'),
    }));
    if (provider.chatCompletionsOnly) {
      lines.push(t(locale, 'config_api_provider_chat_warning', { id: provider.id }));
    }
  }
  return lines;
}

export function formatCodexAuthPoolSummary(locale: AppLocale, stats: CodexAuthPoolStats): string {
  return t(locale, 'auth_pool_summary', {
    total: stats.totalSeen,
    alive: stats.alive,
    deleted: stats.deletedInvalid,
  });
}

export function isInvalidCodexAuthDeleteReason(reason: string | null | undefined): boolean {
  return reason === AUTH_DELETE_REASON_NEEDS_REPAIR;
}

export function configKeyboard(locale: AppLocale, appConfig: AppConfig): Array<Array<{ text: string; callback_data: string }>> {
  const authAutoDeleteEnabled = appConfig.authAutoDeleteNeedsRepair;
  const deleteToolDetailsEnabled = appConfig.telegramDeleteToolDetailsAfterFinal;
  return [
    [{
      text: t(locale, authAutoDeleteEnabled ? 'button_config_auth_auto_delete_off' : 'button_config_auth_auto_delete_on'),
      callback_data: `config:auth_auto_delete:${authAutoDeleteEnabled ? 'off' : 'on'}`,
    }],
    [{
      text: t(locale, deleteToolDetailsEnabled ? 'button_config_delete_tool_details_off' : 'button_config_delete_tool_details_on'),
      callback_data: `config:delete_tool_details:${deleteToolDetailsEnabled ? 'off' : 'on'}`,
    }],
  ];
}

export function formatDurationMs(locale: AppLocale, value: number): string {
  if (value <= 0) {
    return locale === 'zh' ? '关闭' : 'disabled';
  }
  if (value % 60_000 === 0) {
    const minutes = value / 60_000;
    return locale === 'zh' ? `${minutes} 分钟` : `${minutes} min`;
  }
  if (value % 1000 === 0) {
    const seconds = value / 1000;
    return locale === 'zh' ? `${seconds} 秒` : `${seconds} sec`;
  }
  return `${value}ms`;
}

export function parseConfigBooleanArg(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return null;
}

export async function writeEnvBoolean(envPath: string, key: string, enabled: boolean): Promise<void> {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  const nextLine = `${key}=${enabled ? 'true' : 'false'}`;
  let contents = '';
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    await fs.writeFile(envPath, `${nextLine}\n`, { encoding: 'utf8', mode: 0o600 });
    return;
  }
  const pattern = new RegExp(`(^|\\n)[ \\t#]*${escapeRegExp(key)}\\s*=.*(?=\\r?\\n|$)`);
  const nextContents = pattern.test(contents)
    ? contents.replace(pattern, (_match, prefix: string) => `${prefix}${nextLine}`)
    : `${contents}${contents.endsWith('\n') || contents.length === 0 ? '' : '\n'}${nextLine}\n`;
  await fs.writeFile(envPath, nextContents, { encoding: 'utf8', mode: 0o600 });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatRequirementsMessage(locale: AppLocale, requirements: CodexConfigRequirements | null): string {
  const lines = [t(locale, 'requirements_title')];
  if (!requirements) {
    lines.push(t(locale, 'requirements_empty'));
    return lines.join('\n');
  }
  lines.push(`approval: ${requirements.allowedApprovalPolicies?.join(', ') ?? '-'}`);
  lines.push(`sandbox: ${requirements.allowedSandboxModes?.join(', ') ?? '-'}`);
  lines.push(`web_search: ${requirements.allowedWebSearchModes?.join(', ') ?? '-'}`);
  lines.push(`residency: ${requirements.enforceResidency ?? '-'}`);
  if (requirements.featureRequirements) {
    const features = Object.entries(requirements.featureRequirements)
      .map(([key, value]) => `${key}=${value ? 'on' : 'off'}`)
      .join(', ');
    lines.push(`features: ${truncateInline(features, 500)}`);
  }
  return lines.join('\n');
}

export function formatProviderMessage(locale: AppLocale, capabilities: CodexModelProviderCapabilities): string {
  return [
    t(locale, 'provider_title'),
    `webSearch: ${t(locale, capabilities.webSearch ? 'yes' : 'no')}`,
    `imageGeneration: ${t(locale, capabilities.imageGeneration ? 'yes' : 'no')}`,
    `namespaceTools: ${t(locale, capabilities.namespaceTools ? 'yes' : 'no')}`,
  ].join('\n');
}

export function formatGoalMessage(locale: AppLocale, goal: CodexThreadGoal | null, prefix?: string): string {
  const lines = [t(locale, 'goal_title')];
  if (prefix) {
    lines.push(prefix);
  }
  if (!goal) {
    lines.push(t(locale, 'goal_empty'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'goal_status', { value: formatGoalStatus(locale, goal.status) }));
  lines.push(t(locale, 'goal_objective', { value: goal.objective || t(locale, 'empty') }));
  lines.push(t(locale, 'goal_budget', {
    value: goal.tokenBudget === null ? t(locale, 'none') : t(locale, 'goal_tokens', { value: formatTokenCount(goal.tokenBudget) }),
  }));
  lines.push(t(locale, 'goal_usage', {
    tokens: formatTokenCount(goal.tokensUsed),
    seconds: formatCompactNumber(goal.timeUsedSeconds),
  }));
  if (goal.updatedAt > 0) {
    lines.push(t(locale, 'goal_updated_at', { value: formatLocalTimestamp(goal.updatedAt) }));
  }
  return lines.join('\n');
}

export function formatHistoryMessage(locale: AppLocale, threadId: string, turns: AppTurnSnapshot[]): string {
  const lines = [t(locale, 'history_title', { threadId })];
  if (turns.length === 0) {
    lines.push(t(locale, 'history_empty'));
    return lines.join('\n');
  }
  for (const turn of turns.slice(0, 30)) {
    const time = turn.startedAt ? formatLocalTimestamp(turn.startedAt) : t(locale, 'unknown');
    const itemSummary = summarizeTurnItems(turn.items);
    const error = turn.error ? ` · ${truncateInline(turn.error, 80)}` : '';
    lines.push(`- ${turn.turnId} · ${turn.status} · ${time}${error}`);
    if (itemSummary) {
      lines.push(`  ${itemSummary}`);
    }
  }
  return lines.join('\n');
}

export function formatFuzzyFilesMessage(
  locale: AppLocale,
  query: string,
  root: string,
  files: CodexFuzzyFileResult[],
): string {
  const lines = [t(locale, 'files_title', { query, root })];
  if (files.length === 0) {
    lines.push(t(locale, 'files_empty'));
    return lines.join('\n');
  }
  for (const file of files.slice(0, 25)) {
    const displayPath = file.path || file.fileName || '(unknown)';
    lines.push(`- ${displayPath}${file.matchType ? ` (${file.matchType})` : ''}`);
  }
  if (files.length > 25) {
    lines.push(t(locale, 'list_truncated', { count: files.length - 25 }));
  }
  return lines.join('\n');
}

export function formatRemoteStatusMessage(locale: AppLocale, status: RemoteControlStatusState | null): string {
  const lines = [t(locale, 'remote_title')];
  if (!status) {
    lines.push(t(locale, 'remote_unknown'));
    return lines.join('\n');
  }
  lines.push(t(locale, 'remote_status', { value: status.status }));
  lines.push(t(locale, 'remote_environment', { value: status.environmentId ?? t(locale, 'none') }));
  lines.push(t(locale, 'remote_installation', { value: status.installationId ?? t(locale, 'none') }));
  return lines.join('\n');
}

export function formatGoalStatus(locale: AppLocale, status: ThreadGoalStatusValue): string {
  switch (status) {
    case 'paused':
      return t(locale, 'goal_status_paused');
    case 'budgetLimited':
      return t(locale, 'goal_status_budget_limited');
    case 'complete':
      return t(locale, 'goal_status_complete');
    default:
      return t(locale, 'goal_status_active');
  }
}
