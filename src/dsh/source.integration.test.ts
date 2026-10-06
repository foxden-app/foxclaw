import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { DshClient } from './client.js';
import { Logger } from '../logger.js';
import { optionChoices } from './adapter.js';
import { DshCredentials } from './credentials.js';

const sourceDir = process.env.FOXCLAW_DSH_TEST_SOURCE_DIR;

test('real DSH ACP profile loads the bridge plugin, selects models, persists permissions, resumes and cancels', { skip: !sourceDir, timeout: 120000 }, async () => {
  const Client: typeof DshClient = process.env.FOXCLAW_DSH_TEST_BUILT === '1'
    ? (await import(pathToFileURL(path.resolve('dist/dsh/client.js')).href)).DshClient
    : DshClient;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-dsh-source-'));
  const fixtureDir = path.join(sourceDir!, 'apps/cli/tests/profiles/acp/tests/fixtures/control-surface');
  const persistence = path.join(root, 'sessions');
  const patch = path.join(root, 'fixture.patch.yml');
  const authored = await fs.readFile(path.join(fixtureDir, 'cordis.yml'), 'utf8');
  await fs.writeFile(patch, authored
    .replace("'./control-surface-llm.ts'", JSON.stringify(pathToFileURL(path.join(fixtureDir, 'control-surface-llm.ts')).href))
    .replace('!!js process.env.DSH_CONFORMANCE_PERSISTENCE_ROOT', JSON.stringify(persistence)));
  const options = { cliBin: 'dsh', sourceDir: sourceDir!, home: path.join(root, '.dsh'), profile: 'acp', patches: [patch], runtimeDir: path.join(root, 'runtime'), startupTimeoutMs: 60000 };
  const logger = new Logger('error', path.join(root, 'test.log'));
  let client = new Client(options, 'source', logger);
  try {
    const credentials = new DshCredentials(options, logger);
    try {
      assert.deepEqual(await credentials.describe(), { configured: false, writable: true });
      assert.deepEqual(await credentials.set('fixture-key-not-used'), { configured: true, writable: true });
      assert.deepEqual(await credentials.describe(), { configured: true, writable: true });
    } finally { await credentials.stop(); }
    await client.setAccess('full-access');
    const id = await client.session(root);
    const models = optionChoices(client.configOptions(id).find(option => option.id === 'model'));
    const beta = models.find(model => model.name === 'Beta');
    assert.ok(beta);
    await client.setConfig(id, 'model', beta.value);
    await client.setConfig(id, 'reasoning_effort', 'low');
    await client.agent.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'exercise controls' }] });
    await client.stop();
    const findLog = async (dir: string): Promise<string> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) { const found = await findLog(target); if (found) return found; }
        else if (entry.name.endsWith('.jsonl')) {
          const content = await fs.readFile(target, 'utf8');
          if (content.includes(id)) return content;
        }
      }
      return '';
    };
    assert.match(await findLog(persistence), /danger-full-access/);
    client = new Client(options, 'source', logger);
    await client.setAccess('read-only');
    assert.equal(await client.session(root, id), id);
    const updates: string[] = [];
    let toolFinished!: () => void;
    const started = new Promise<void>(resolve => { toolFinished = resolve; });
    client.on('update', notification => {
      updates.push(notification.update.sessionUpdate);
      if (notification.update.sessionUpdate === 'tool_call_update') toolFinished();
    });
    const prompt = client.agent.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'cancel after tool' }] });
    await started;
    await client.agent.notify('session/cancel', { sessionId: id });
    assert.equal((await prompt).stopReason, 'cancelled');
    await client.stop();
    assert.match(await findLog(persistence), /read-only/);
    assert.ok(updates.includes('tool_call'));
  } finally { await client.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
