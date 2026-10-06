import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDshSetupDefinition } from './setup.js';
import { fakeDsh } from './test_support.js';
import { Logger } from '../logger.js';

test('DSH setup accepts a local JS CLI, replaces source settings, and checks real ACP startup', async () => {
  const fixture = await fakeDsh();
  const definition = createDshSetupDefinition(new Logger('error', path.join(fixture.root, 'setup.log')),
    { DSH_HOME: fixture.options.home!, PATH: '' }, path.join(fixture.root, 'managed'));
  try {
    await assert.rejects(definition.fromPath('relative/dsh'), /absolute/);
    const candidate = await definition.fromPath(fixture.options.cliBin);
    assert.equal(candidate.updates.DSH_SOURCE_DIR, '');
    assert.equal(candidate.updates.DSH_CLI_BIN, fixture.options.cliBin);
    const alias = path.join(fixture.root, 'stable-cli.mjs');
    await fs.symlink(fixture.options.cliBin, alias);
    assert.equal((await definition.fromPath(alias)).updates.DSH_CLI_BIN, alias);
    await definition.validate(candidate, new AbortController().signal);
    const invalidTimeout = createDshSetupDefinition(new Logger('error', path.join(fixture.root, 'setup.log')),
      { DSH_STARTUP_TIMEOUT_MS: '-1' });
    await assert.rejects(invalidTimeout.validate(candidate, new AbortController().signal), /positive integer/);
    await assert.rejects(definition.fromPath(fixture.root));
  } finally { await fixture.cleanup(); }
});

test('DSH setup shutdown cancels an unresponsive ACP handshake before its startup timeout', async () => {
  const fixture = await fakeDsh();
  const stalled = path.join(fixture.root, 'stalled.mjs');
  await fs.writeFile(stalled, 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));');
  const definition = createDshSetupDefinition(new Logger('error', path.join(fixture.root, 'setup.log')),
    { PATH: '' }, path.join(fixture.root, 'managed'));
  const controller = new AbortController();
  try {
    const candidate = await definition.fromPath(stalled);
    const check = definition.validate(candidate, controller.signal);
    const rejection = assert.rejects(check);
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    await rejection;
    assert.ok(Date.now() - start < 3000, 'cancelled check must not wait for a 60-second startup timeout');
  } finally { await fixture.cleanup(); }
});

test('discovery finds configured CLI/source paths without requiring DSH to be enabled', async () => {
  const fixture = await fakeDsh();
  const source = path.join(fixture.root, 'deepseek-harness');
  await fs.mkdir(path.join(source, 'apps', 'cli', 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'apps', 'cli', 'src', 'bin.ts'), '');
  const definition = createDshSetupDefinition(new Logger('error', path.join(fixture.root, 'setup.log')),
    { DSH_ENABLED: 'false', DSH_CLI_BIN: fixture.options.cliBin, DSH_SOURCE_DIR: source, PATH: '' }, path.join(fixture.root, 'managed'));
  try {
    const realSource = await fs.realpath(source);
    const candidates = await definition.discover();
    assert.ok(candidates.some(candidate => candidate.updates.DSH_SOURCE_DIR === realSource));
    assert.ok(candidates.some(candidate => candidate.updates.DSH_CLI_BIN === fixture.options.cliBin));
  } finally { await fixture.cleanup(); }
});
