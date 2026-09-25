import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStreamPreviewContent } from './stream_preview.js';

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
