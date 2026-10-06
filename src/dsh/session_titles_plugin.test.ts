import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply, readSessionTitle } from './session_titles_plugin.js';

test('DSH names prefer native titles and derive old sessions from the first human message', async () => {
  const query = {
    readTitle: async (id: string) => id === 'named' ? { title: '已命名会话' } : undefined,
    readSession: async () => ({ events: [
      { type: 'user/message', data: { source: { kind: 'tool' }, content: [{ type: 'text', text: 'internal message' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '修复\n  会话名称' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'later prompt' }] } },
    ] }),
  };
  assert.equal(await readSessionTitle(query, 'named'), '已命名会话');
  assert.equal(await readSessionTitle(query, 'legacy'), '修复 会话名称');
  assert.equal(await readSessionTitle({ ...query, readSession: async () => ({ events: [] }) }, 'empty'), undefined);
});

test('DSH title mailbox isolates unreadable sessions and drains on disposal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foxclaw-titles-'));
  let dispose!: () => Promise<void>;
  try {
    await apply({
      sessionQuery: {
        readTitle: async id => { if (id === 'broken') throw new Error('unreadable'); return { title: `Title ${id}` }; },
        readSession: async () => ({ events: [] }),
      },
      effect: callback => { dispose = callback(); },
    }, { directory });
    await fs.writeFile(path.join(directory, 'abc.request'), JSON.stringify(['one', 'broken', 'two']));
    let result: string | undefined;
    for (let i = 0; i < 100 && !result; i++) {
      try { result = await fs.readFile(path.join(directory, 'abc.response'), 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(result);
    assert.deepEqual(JSON.parse(result), { one: 'Title one', two: 'Title two' });
    await dispose();
    await assert.rejects(fs.access(path.join(directory, 'ready')));
  } finally { await dispose?.(); await fs.rm(directory, { recursive: true, force: true }); }
});
