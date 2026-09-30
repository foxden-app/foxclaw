import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  AntigravitySubagentTracker,
  cleanParameterValue,
  extractSubagentToolSummary,
} from './subagents.js';

test('cleanParameterValue removes surrounding quotes and trims', () => {
  assert.equal(cleanParameterValue('"hello"'), 'hello');
  assert.equal(cleanParameterValue('  "curl -I https://foo.com"  '), 'curl -I https://foo.com');
  assert.equal(cleanParameterValue('plain string'), 'plain string');
  assert.equal(cleanParameterValue(123), '');
});

test('extractSubagentToolSummary extracts readable summary from tool params', () => {
  assert.equal(
    extractSubagentToolSummary('run_command', { CommandLine: '"curl -I https://foxden.app"' }),
    '$ curl -I https://foxden.app',
  );
  assert.equal(
    extractSubagentToolSummary('view_file', { AbsolutePath: '"/home/user/project/src/main.ts"' }),
    'main.ts',
  );
  assert.equal(
    extractSubagentToolSummary('custom_tool', { toolSummary: '"Checking deployment status"' }),
    'Checking deployment status',
  );
  assert.equal(
    extractSubagentToolSummary('json_params', JSON.stringify({ TargetFile: '/app/index.js' })),
    'index.js',
  );
});

test('AntigravitySubagentTracker discovers subagents from SQLite database and transcript files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-subagent-test-'));
  try {
    const dbPath = path.join(tempDir, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id text PRIMARY KEY,
          title text NOT NULL DEFAULT "",
          preview text NOT NULL DEFAULT "",
          step_count integer NOT NULL DEFAULT 0,
          last_modified_time datetime NOT NULL,
          workspace_uris text NOT NULL DEFAULT "[]",
          status text NOT NULL DEFAULT "",
          agent_name text NOT NULL DEFAULT "",
          parent_conversation_id text NOT NULL DEFAULT "",
          nesting_depth integer NOT NULL DEFAULT 0,
          not_fully_idle numeric NOT NULL DEFAULT 1,
          killed numeric NOT NULL DEFAULT 0
        );
      `);

      const parentId = 'parent-conv-123';
      const subId1 = 'sub-conv-456';
      const subId2 = 'sub-conv-789';

      db.prepare(`
        INSERT INTO conversation_summaries
          (conversation_id, agent_name, parent_conversation_id, nesting_depth, status, not_fully_idle, killed, last_modified_time)
        VALUES
          (?, 'DeepInvestigator', ?, 1, 'CASCADE_RUN_STATUS_RUNNING', 1, 0, datetime('now')),
          (?, 'DeepCoder', ?, 1, 'CASCADE_RUN_STATUS_RUNNING', 1, 0, datetime('now'))
      `).run(subId1, parentId, subId2, parentId);
    } finally {
      db.close();
    }

    const parentId = 'parent-conv-123';
    const subId1 = 'sub-conv-456';

    // Create transcript directories
    const sub1Dir = path.join(tempDir, 'brain', subId1, '.system_generated', 'logs');
    fs.mkdirSync(sub1Dir, { recursive: true });
    const sub1Transcript = path.join(sub1Dir, 'transcript.jsonl');

    // Write initial subagent log lines
    fs.writeFileSync(
      sub1Transcript,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: '"curl -I https://foxden.app/api/v1/version"',
              toolSummary: '"Checking version endpoint"',
            },
          },
        ],
      }) + '\n',
    );

    const tracker = new AntigravitySubagentTracker(parentId, tempDir);
    const poll1 = await tracker.poll();

    assert.equal(poll1.subagents.length, 2, 'Should discover both subagents from DB');
    assert.equal(poll1.hasUpdates, true);
    assert.equal(poll1.newToolEvents.length, 1);
    assert.equal(poll1.newToolEvents[0]?.toolName, 'run_command');
    assert.equal(poll1.newToolEvents[0]?.subagentName, 'DeepInvestigator');
    assert.equal(poll1.newToolEvents[0]?.summary, 'Checking version endpoint');

    const summaryLine = tracker.getActiveSummaryLine('zh');
    assert.ok(summaryLine?.includes('DeepInvestigator'));
    assert.ok(summaryLine?.includes('run_command'));

    // Append a completion event (send_message)
    fs.appendFileSync(
      sub1Transcript,
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            name: 'send_message',
            args: {
              Recipient: parentId,
              Message: 'Deployment verified successfully!',
            },
          },
        ],
      }) + '\n',
    );

    const poll2 = await tracker.poll();
    assert.equal(poll2.hasUpdates, true);

    const sub1 = tracker.getSubagents().find((s) => s.conversationId === subId1);
    assert.equal(sub1?.status, 'done', 'Subagent should be marked done after send_message');

    const tgBlock = tracker.renderTelegramBlock('zh');
    assert.ok(tgBlock.includes('子 Agent 实时动态'));
    assert.ok(tgBlock.includes('DeepInvestigator'));
    assert.ok(tgBlock.includes('已完成'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
