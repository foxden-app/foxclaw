import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from './permissions_plugin.js';

test('DSH permissions use native presets on restore and before requests, while children retain inheritance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-permission-test-'));
  const policyPath = path.join(root, 'permissions');
  const listeners = new Map<string, (...args: any[]) => any>();
  const selections: string[] = [];
  try {
    fs.writeFileSync(policyPath, 'workspace-write');
    apply({ permissionPresets: { set: (_session, preset) => { selections.push(preset); } }, on: (event: string, listener: (...args: any[]) => any) => { listeners.set(event, listener); } }, { policyPath });
    const rootSession = { header: {} };
    listeners.get('agent/created')!({ agent: { session: rootSession } });
    fs.writeFileSync(policyPath, 'danger-full-access');
    assert.equal(await listeners.get('agent/pre-step')!({ agent: { session: rootSession } }, async () => 'continued'), 'continued');
    listeners.get('agent/created')!({ agent: { session: { header: { parentSession: 'root' } } } });
    assert.deepEqual(selections, ['workspace-write', 'danger-full-access']);
    fs.writeFileSync(policyPath, 'read-only');
    listeners.get('agent/created')!({ agent: { session: rootSession } });
    assert.equal(selections.at(-1), 'read-only');
    fs.writeFileSync(policyPath, 'unknown');
    await assert.rejects(listeners.get('agent/pre-step')!({ agent: { session: rootSession } }, async () => 'continued'), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
