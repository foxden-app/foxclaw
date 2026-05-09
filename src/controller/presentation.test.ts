import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccessSettingsKeyboard,
  buildModelSettingsKeyboard,
  buildSetupPanelKeyboard,
  buildThreadListKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatAccessSettingsMessage,
  formatAccessPresetLabel,
  formatApprovalPolicyLabel,
  formatModelSettingsMessage,
  formatSandboxModeLabel,
  formatSetupPanelMessage,
  formatThreadsMessage,
  formatWeixinAccessCopyPaste,
  formatWeixinModelCopyPaste,
  formatWeixinThreadsCopyPaste,
  formatWeixinWhereNavCopyPaste,
  normalizeRequestedEffort,
  resolveRequestedModel,
  resolveSetupSummaryLine,
} from './presentation.js';
import type { AppThread, ChatSessionSettings, ModelInfo } from '../types.js';

test('formatThreadsMessage highlights current thread and metadata', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-1',
      name: 'Fix Telegram bridge',
      preview: 'Split long replies and clean previews',
      cwd: '/tmp/project',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/project/thread-1.jsonl',
      status: 'idle',
      updatedAt: Math.floor(Date.now() / 1000) - 120,
    },
  ];

  const rendered = formatThreadsMessage('en', threads, 'thread-1');
  assert.match(rendered, /<b>Recent threads<\/b>/);
  assert.match(rendered, /Tap a button below to open a thread/);
  assert.match(rendered, /Current: <b>Fix Telegram bridge<\/b>/);
  assert.match(rendered, /project \| 2m ago/);
});

test('formatThreadsMessage escapes html and shows filter', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-2',
      name: 'Review <auth> flow',
      preview: 'Review <auth> flow',
      cwd: '/tmp/repo',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/repo/thread-2.jsonl',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];

  const rendered = formatThreadsMessage('en', threads, null, 'auth <bug>');
  assert.match(rendered, /Filter: <code>auth &lt;bug&gt;<\/code>/);
  assert.doesNotMatch(rendered, /Review <auth> flow/);
});

test('buildThreadsKeyboard creates one open button per thread', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-2',
      name: 'Review auth flow',
      preview: 'Review auth flow',
      cwd: '/tmp/repo',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/repo/thread-2.jsonl',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];

  assert.deepEqual(buildThreadsKeyboard('en', threads), [[{
    text: '1. Review auth flow',
    callback_data: 'thread:open:thread-2',
  }]]);
});

test('buildThreadsKeyboard uses ThreadLike.index for ordinals', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-x',
      name: 'Later page',
      preview: 'p',
      cwd: '/tmp',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/x.jsonl',
      status: 'idle',
      updatedAt: 1,
    },
  ];
  assert.deepEqual(buildThreadsKeyboard('en', [{ ...threads[0]!, index: 11 } as AppThread & { index: number }]), [[{
    text: '11. Later page',
    callback_data: 'thread:open:thread-x',
  }]]);
});

test('formatThreadsMessage shows range when listState is set', () => {
  const threads: AppThread[] = [
    {
      threadId: 't1',
      name: 'A',
      preview: 'a',
      cwd: '/tmp',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/t.jsonl',
      status: 'idle',
      updatedAt: 1,
    },
  ];
  const rendered = formatThreadsMessage('en', threads, null, null, {
    offset: 10,
    pageSize: 10,
    hasPreviousPage: true,
    hasNextPage: false,
    searchTerm: null,
  });
  assert.match(rendered, /Showing 11-11/);
});

test('buildThreadListKeyboard adds Prev/Next and clear filter', () => {
  const row: AppThread & { index: number } = {
    threadId: 'thread-2',
    name: 'Review auth flow',
    preview: 'Review auth flow',
    cwd: '/tmp/repo',
    modelProvider: 'openai',
    source: 'cli',
    path: '/tmp/repo/thread-2.jsonl',
    status: 'active',
    updatedAt: Math.floor(Date.now() / 1000) - 30,
    index: 11,
  };
  assert.deepEqual(
    buildThreadListKeyboard('en', [row], {
      offset: 10,
      pageSize: 10,
      hasPreviousPage: true,
      hasNextPage: true,
      searchTerm: 'auth',
    }),
    [
      [{ text: '11. Review auth flow', callback_data: 'thread:open:thread-2' }],
      [
        { text: 'Prev', callback_data: 'thread:list:prev' },
        { text: 'Next', callback_data: 'thread:list:next' },
      ],
      [{ text: 'Clear filter', callback_data: 'thread:list:clear' }],
    ],
  );
});

test('formatModelSettingsMessage renders current selections', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-1',
    model: 'o3',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: null,
    collaborationMode: null,
    serviceTier: null,
    updatedAt: Date.now(),
  };

  const rendered = formatModelSettingsMessage('en', models, settings);
  assert.match(rendered, /<b>Model settings<\/b>/);
  assert.match(rendered, /Model: <b>o3<\/b>/);
  assert.match(rendered, /Effort: <b>high<\/b>/);
  assert.match(rendered, /Supported efforts: <code>medium, high<\/code>/);
});

test('buildModelSettingsKeyboard marks selected model and effort', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
    {
      id: 'model-o4-mini',
      model: 'o4-mini',
      displayName: 'OpenAI o4-mini',
      description: 'Fast model',
      isDefault: false,
      supportedReasoningEfforts: ['low', 'medium'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-1',
    model: 'o3',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: null,
    collaborationMode: null,
    serviceTier: null,
    updatedAt: Date.now(),
  };

  const keyboard = buildModelSettingsKeyboard('en', models, settings);
  assert.deepEqual(keyboard[0], [
    { text: 'Auto', callback_data: 'settings:model:default' },
    { text: '• o3', callback_data: 'settings:model:o3' },
  ]);
  assert.deepEqual(keyboard[1], [
    { text: 'o4-mini', callback_data: 'settings:model:o4-mini' },
  ]);
  assert.equal(keyboard.at(-1)?.at(-1)?.text, '• high');
});

test('resolveRequestedModel matches model ids and display names', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];

  assert.equal(resolveRequestedModel(models, 'o3')?.model, 'o3');
  assert.equal(resolveRequestedModel(models, 'OpenAI o3')?.model, 'o3');
  assert.equal(resolveRequestedModel(models, 'missing'), null);
});

test('clampEffortToModel falls back to model default when unsupported', () => {
  const model: ModelInfo = {
    id: 'model-o4-mini',
    model: 'o4-mini',
    displayName: 'OpenAI o4-mini',
    description: 'Fast model',
    isDefault: false,
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
  };

  assert.deepEqual(clampEffortToModel(model, 'high'), {
    effort: 'medium',
    adjustedFrom: 'high',
  });
  assert.deepEqual(clampEffortToModel(model, 'low'), {
    effort: 'low',
    adjustedFrom: null,
  });
});

test('normalizeRequestedEffort validates allowed effort names', () => {
  assert.equal(normalizeRequestedEffort('HIGH'), 'high');
  assert.equal(normalizeRequestedEffort('invalid'), null);
});

test('access presentation renders current preset and marks selected option', () => {
  const access = {
    preset: 'full-access' as const,
    approvalPolicy: 'never' as const,
    sandboxMode: 'danger-full-access' as const,
  };

  const rendered = formatAccessSettingsMessage('en', access);
  assert.match(rendered, /<b>Access settings<\/b>/);
  assert.match(rendered, /Preset: <b>Full access<\/b>/);
  assert.match(rendered, /Approval policy: <b>Never ask<\/b>/);
  assert.match(rendered, /Sandbox: <b>Danger full access<\/b>/);

  assert.deepEqual(buildAccessSettingsKeyboard('en', access), [[
    { text: 'Read-only', callback_data: 'settings:access:read-only' },
    { text: 'Default', callback_data: 'settings:access:default' },
    { text: '• Full access', callback_data: 'settings:access:full-access' },
  ]]);
});

test('access labels render in chinese locale', () => {
  assert.equal(formatAccessPresetLabel('zh', 'read-only'), '只读');
  assert.equal(formatApprovalPolicyLabel('zh', 'on-request'), '按需询问');
  assert.equal(formatSandboxModeLabel('zh', 'workspace-write'), '工作区可写');
});

test('setup panel renders summary, focus, rows, and fast controls', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-gpt-5',
      model: 'gpt-5',
      displayName: 'GPT-5',
      description: 'Default model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [{ id: 'priority', name: 'fast', description: 'Fast lane' }],
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-setup',
    model: 'gpt-5',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: 'full-access',
    collaborationMode: 'plan',
    serviceTier: 'priority',
    updatedAt: 0,
  };
  const access = {
    preset: 'full-access' as const,
    approvalPolicy: 'never' as const,
    sandboxMode: 'danger-full-access' as const,
  };

  const ctx = { focus: 'model' as const, models, settings, access };
  assert.equal(resolveSetupSummaryLine(ctx), 'gpt-5 · high · fast=on · full-access · plan');
  const message = formatSetupPanelMessage('en', ctx);
  assert.match(message, /<b>Session preferences<\/b>/);
  assert.match(message, /Current: <b>gpt-5 · high · fast=on · full-access · plan<\/b>/);
  assert.match(message, /Focus: Model/);
  assert.match(message, /• Fast: on \(fast\)/);

  const keyboard = buildSetupPanelKeyboard('en', ctx);
  assert.ok(keyboard.some(row => row.some(button => button.callback_data === 'setup:model:gpt-5')));
  assert.ok(keyboard.some(row => row.some(button => button.callback_data === 'setup:effort:high')));
  assert.deepEqual(keyboard.find(row => row.some(button => button.callback_data.startsWith('setup:fast:'))), [
    { text: '• ⚡ Fast: on', callback_data: 'setup:fast:on' },
    { text: 'Fast: off', callback_data: 'setup:fast:off' },
  ]);
});

test('setup panel shows unsupported fast as noop button', () => {
  const models: ModelInfo[] = [
    {
      id: 'model-gpt-5-codex',
      model: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      description: 'No fast tier',
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];
  const access = {
    preset: 'default' as const,
    approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const,
  };
  const ctx = { focus: 'fast' as const, models, settings: null, access };
  assert.equal(resolveSetupSummaryLine(ctx), 'server default · server default · fast=unsupported · default · default');
  assert.match(formatSetupPanelMessage('en', ctx), /Focus: Fast/);
  assert.deepEqual(buildSetupPanelKeyboard('en', ctx).at(-3), [
    { text: 'Fast unsupported', callback_data: 'setup:fast:unsupported' },
  ]);
});

test('presentation renders chinese locale strings', () => {
  const threads: AppThread[] = [
    {
      threadId: 'thread-zh',
      name: '修复桥接',
      preview: '修复桥接',
      cwd: '/tmp/project',
      modelProvider: 'openai',
      source: 'cli',
      path: '/tmp/project/thread-zh.jsonl',
      status: 'active',
      updatedAt: Math.floor(Date.now() / 1000) - 30,
    },
  ];
  const renderedThreads = formatThreadsMessage('zh', threads, 'thread-zh');
  assert.match(renderedThreads, /<b>最近线程<\/b>/);
  assert.match(renderedThreads, /点击下方按钮即可切换线程/);
  assert.match(renderedThreads, /当前：<b>修复桥接<\/b>/);

  const models: ModelInfo[] = [
    {
      id: 'model-o3',
      model: 'o3',
      displayName: 'OpenAI o3',
      description: 'Reasoning model',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
  ];
  const settings: ChatSessionSettings = {
    chatId: 'chat-zh',
    model: null,
    reasoningEffort: null,
    locale: 'zh',
    accessPreset: null,
    collaborationMode: null,
    serviceTier: null,
    updatedAt: Date.now(),
  };
  const renderedModels = formatModelSettingsMessage('zh', models, settings);
  assert.match(renderedModels, /<b>模型设置<\/b>/);
  assert.match(renderedModels, /模型：<b>服务端默认<\/b>/);
  assert.match(renderedModels, /推理强度：<b>服务端默认<\/b>/);
});

test('formatWeixinThreadsCopyPaste lists /open lines and filter hint', () => {
  const empty = formatWeixinThreadsCopyPaste('en', []);
  assert.match(empty, /^---\n/);
  assert.match(empty, /Copy-paste \(WeChat\):/);
  assert.match(empty, /\(Empty list/);
  assert.match(empty, /Filter: \/threads <keyword>/);

  const withFilter = formatWeixinThreadsCopyPaste(
    'en',
    [
      { threadId: 'a', name: 'One', preview: 'p1' },
      { threadId: 'b', name: 'Two', preview: 'p2' },
    ],
    'bug',
  );
  assert.match(withFilter, /Current filter: bug/);
  assert.match(withFilter, /\/open 1\n\/open 2/);

  const paged = formatWeixinThreadsCopyPaste(
    'en',
    [
      { threadId: 'a', name: 'One', preview: 'p1' },
    ],
    null,
    10,
  );
  assert.match(paged, /\/open 11/);
});

test('formatWeixinModelCopyPaste mirrors model list and efforts', () => {
  const models: ModelInfo[] = [
    {
      id: 'm1',
      model: 'o3',
      displayName: 'O3',
      description: '',
      isDefault: true,
      supportedReasoningEfforts: ['medium', 'high'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
    },
    {
      id: 'm2',
      model: 'gpt-4',
      displayName: 'G4',
      description: '',
      isDefault: false,
      supportedReasoningEfforts: ['low'],
      defaultReasoningEffort: 'low',
      serviceTiers: [],
    },
  ];
  const out = formatWeixinModelCopyPaste('en', models, {
    chatId: 'c',
    model: 'o3',
    reasoningEffort: 'high',
    locale: 'en',
    accessPreset: null,
    collaborationMode: null,
    serviceTier: null,
    updatedAt: 0,
  });
  assert.match(out, /\/model default/);
  assert.match(out, /\/model o3/);
  assert.match(out, /\/model gpt-4/);
  assert.match(out, /\/effort default/);
  assert.match(out, /\/effort medium\n\/effort high/);
  assert.match(out, /\/fast on\n\/fast off/);
});

test('formatWeixinAccessCopyPaste lists preset commands', () => {
  const out = formatWeixinAccessCopyPaste('en');
  assert.match(out, /\/access read-only/);
  assert.match(out, /\/access default/);
  assert.match(out, /\/access full-access/);
});

test('formatWeixinWhereNavCopyPaste adds /reveal when bound', () => {
  assert.doesNotMatch(formatWeixinWhereNavCopyPaste('en', false), /\/reveal/);
  assert.match(formatWeixinWhereNavCopyPaste('en', true), /\/reveal/);
});
