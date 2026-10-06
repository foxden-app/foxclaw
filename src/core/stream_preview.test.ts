import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderStreamPreviewContent,
  formatElapsedDuration,
  buildFoldedToolsSummary,
  combineSummaryAndResponse,
} from './stream_preview.js';

test('renderStreamPreviewContent formats thinking state, tools, and text previews', () => {
  const initial = renderStreamPreviewContent({
    toolLines: [],
    accumulatedText: '',
    engineName: 'Antigravity',
  });
  assert.ok(initial.includes('⏳ Antigravity 正在思考中…'));

  const boostInitial = renderStreamPreviewContent({
    toolLines: [],
    accumulatedText: '',
    isBoost: true,
    engineName: 'Antigravity',
  });
  assert.ok(boostInitial.includes('🚀 Antigravity (Boost 模式) 正在深度思考中…'));

  const withToolsAndText = renderStreamPreviewContent({
    toolLines: ['⚙️ `view_file`', '✅ `view_file`'],
    accumulatedText: 'Hello world response',
    engineName: 'Antigravity',
  });
  assert.ok(withToolsAndText.includes('<blockquote'));
  assert.ok(withToolsAndText.includes('正在调用工具 (2 项)'));
  assert.ok(withToolsAndText.includes('Hello world response'));

  const withLiveMeta = renderStreamPreviewContent({
    toolLines: ['✅ `run_command`'],
    accumulatedText: 'Building project...',
    engineName: 'Antigravity',
    stepIndex: 3,
    toolCount: 5,
    currentTool: 'run_command ($ npm run build)',
    elapsedSeconds: 12,
  });
  assert.ok(withLiveMeta.includes('第 3 轮 · 累计执行 5 次工具 · 已耗时 12s'));
  assert.ok(withLiveMeta.includes('当前正在运行'));
  assert.ok(withLiveMeta.includes('run_command ($ npm run build)'));
});

test('formatElapsedDuration formats seconds, minutes, and hours accurately', () => {
  assert.equal(formatElapsedDuration(0), '0s');
  assert.equal(formatElapsedDuration(45, 'zh'), '45秒');
  assert.equal(formatElapsedDuration(45, 'en'), '45s');
  assert.equal(formatElapsedDuration(85, 'zh'), '1分25秒');
  assert.equal(formatElapsedDuration(85, 'en'), '1m 25s');
  assert.equal(formatElapsedDuration(120, 'zh'), '2分');
  assert.equal(formatElapsedDuration(3660, 'zh'), '1小时1分');
  assert.equal(formatElapsedDuration(3660, 'en'), '1h 1m');
});

test('buildFoldedToolsSummary preserves all tool steps when <= 25 (e.g. Codex 10-20 sections)', () => {
  // 15 steps (like Codex commentary / step summaries)
  const codexSteps = Array.from({ length: 15 }, (_, i) => `⚙️ <code>step_${i}</code> · <i>执行步骤 ${i}</i>`);
  const summary = buildFoldedToolsSummary({
    stepIndex: 15,
    toolLines: codexSteps,
    toolCount: 15,
    durationSeconds: 45,
    usage: {
      inputTokens: 50000,
      outputTokens: 5000,
      cachedTokens: 10000,
      totalTokens: 65000,
    },
    locale: 'zh',
  });

  assert.ok(summary.startsWith('<blockquote expandable>'));
  assert.ok(summary.endsWith('</blockquote>\n\n'));
  assert.ok(summary.includes('🛠️ <b>执行小结 · 共 15 轮 · 累计执行 15 次工具 · 耗时 45秒</b>'));
  assert.ok(summary.includes('🪙 <b>Token 消耗</b>: 总计 65K (输入 50K · 输出 5K · 缓存 10K)'));

  // Ensure ALL 15 steps are preserved in the fold, not omitted!
  for (let i = 0; i < 15; i++) {
    assert.ok(summary.includes(`step_${i}`), `Should preserve step_${i}`);
  }
  assert.ok(!summary.includes('折叠收起'), 'Should not omit any step when count <= 25');
});

test('buildFoldedToolsSummary safely bounds very large tool sets (> 25 tools)', () => {
  const dummyTools = Array.from({ length: 107 }, (_, i) => `⚙️ <code>tool_${i}</code>`);
  const summary = buildFoldedToolsSummary({
    stepIndex: 2048,
    toolLines: dummyTools,
    toolCount: 107,
    durationSeconds: 85,
    usage: {
      inputTokens: 120100,
      outputTokens: 4200,
      cachedTokens: 28000,
      totalTokens: 152300,
    },
    locale: 'zh',
  });

  assert.ok(summary.startsWith('<blockquote expandable>'));
  assert.ok(summary.endsWith('</blockquote>\n\n'));
  assert.ok(summary.includes('🛠️ <b>执行小结 · 共 2048 轮 · 累计执行 107 次工具 · 耗时 1分25秒</b>'));
  assert.ok(summary.includes('🪙 <b>Token 消耗</b>: 总计 152.3K (输入 120.1K · 输出 4.2K · 缓存 28K)'));

  // First 3 items preserved
  assert.ok(summary.includes('tool_0'));
  assert.ok(summary.includes('tool_1'));
  assert.ok(summary.includes('tool_2'));

  // Middle omitted note
  assert.ok(summary.includes('(中间 89 项历史工具调用已折叠收起)'));

  // Last 15 items preserved
  assert.ok(summary.includes('tool_92'));
  assert.ok(summary.includes('tool_106'));

  // Strictly bounded under 1800 chars so it never breaks Telegram limits
  assert.ok(summary.length < 1800, `Summary length ${summary.length} should be < 1800`);
});

test('combineSummaryAndResponse guarantees folded summary is never torn or leaked onto response', () => {
  const folded = '<blockquote expandable>🛠️ <b>执行小结 · 耗时 30秒</b>\n⚙️ <code>test</code></blockquote>\n\n';

  // 1. Short response: fits in one chunk
  const shortChunks = combineSummaryAndResponse(folded, 'Short response', 4000);
  assert.equal(shortChunks.length, 1);
  assert.equal(shortChunks[0], `${folded}Short response`);

  // 2. Long response (5000 chars): folded summary is completely in chunk 0, chunk 1 contains rest of response
  const longResponse = `${'Para1 content.\n\n'.repeat(150)}${'Para2 content.\n\n'.repeat(150)}`;
  const chunks = combineSummaryAndResponse(folded, longResponse, 4000);
  assert.ok(chunks.length >= 2);

  // Chunk 0 must start with the full blockquote and end with </blockquote>\n\n before paragraph text
  assert.ok(chunks[0]!.startsWith(folded));
  assert.ok(chunks[0]!.length <= 4000);

  // Chunk 1 and later must NOT contain any blockquote or tool lines
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(!chunks[i]!.includes('<blockquote>'));
    assert.ok(!chunks[i]!.includes('</blockquote>'));
    assert.ok(!chunks[i]!.includes('执行小结'));
    assert.ok(!chunks[i]!.includes('<code>test</code>'));
  }
});


test('large formatted tool summaries stay bounded and are never split into broken HTML', () => {
  const tools = Array.from({ length: 25 }, (_, i) => `<code>tool_${i}</code> · ${'&lt;'.repeat(180)}`);
  const folded = buildFoldedToolsSummary({ toolLines: tools, toolCount: 25, durationSeconds: 45 });
  assert.ok(folded.length < 2000);
  assert.match(folded, /另有/);
  const chunks = combineSummaryAndResponse(folded, 'answer');
  assert.equal(chunks.length, 1);
  assert.equal((chunks[0]!.match(/<blockquote expandable>/g) ?? []).length, 1);
  assert.equal((chunks[0]!.match(/<\/blockquote>/g) ?? []).length, 1);
});
