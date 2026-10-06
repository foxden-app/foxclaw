import test from 'node:test';
import assert from 'node:assert/strict';
import type { TelegramGateway } from './gateway.js';
import { TelegramTaskPreviews } from './task_preview.js';
import { telegramTaskResult } from './task_result.js';

function fixture() {
  const calls: Array<{ kind: string; args: any[] }> = [];
  const generations = new Map<number, any>();
  let failDraft = false;
  const gateway = {
    registerGeneration: (...args: any[]) => { generations.set(args[0], args); },
    releaseGeneration: (id: number) => { generations.delete(id); },
    sendRichMessageDraft: async (...args: any[]) => { calls.push({ kind: 'draft', args }); if (failDraft) throw new Error('drafts unsupported'); },
    sendMessageDraft: async (...args: any[]) => { calls.push({ kind: 'clear', args }); },
    sendRichMessage: async (...args: any[]) => { calls.push({ kind: 'send', args }); return 77; },
    sendHtmlMessage: async (...args: any[]) => { calls.push({ kind: 'html-send', args }); return 78; },
    editRichMessage: async (...args: any[]) => { calls.push({ kind: 'edit', args }); },
    editHtmlMessage: async (...args: any[]) => { calls.push({ kind: 'html-edit', args }); },
  } as unknown as TelegramGateway;
  return { calls, generations, previews: new TelegramTaskPreviews(gateway), fail: () => { failDraft = true; } };
}

test('private task uses one correlated stoppable draft, never persists its id as a message and releases it on completion', async () => {
  const f = fixture();
  assert.equal(await f.previews.begin('telegram:42::root', 'task', 'thinking'), 0);
  await f.previews.update('telegram:42::root', 'task', 0, '<b>working</b>');
  const drafts = f.calls.filter(c => c.kind === 'draft');
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0]!.args[1], drafts[1]!.args[1]);
  assert.equal(drafts[0]!.args[4], true);
  assert.equal(f.calls.filter(c => c.kind === 'send').length, 0);
  assert.equal(f.generations.size, 1);
  await f.previews.end('telegram:43::root', 'task');
  assert.equal(f.generations.size, 1);
  await f.previews.end('telegram:42::root', 'task');
  await f.previews.end('telegram:42::root', 'task');
  assert.equal(f.generations.size, 0);
  assert.equal(f.calls.filter(c => c.kind === 'clear').length, 1);
  assert.equal(f.calls.find(c => c.kind === 'clear')!.args[2], '');
});

test('group progress and retry reuse one card; stop buttons carry the precise task id', async () => {
  const f = fixture(); const scope = 'telegram:-99::5';
  assert.equal(await f.previews.begin(scope, 'task', 'thinking'), 77);
  await f.previews.update(scope, 'task', 77, '<b>step one</b>');
  await f.previews.update(scope, 'task', 77, '<b>step two</b>');
  await f.previews.end(scope, 'task');
  assert.equal(await f.previews.begin(scope, 'task', 'retrying', 77), 77);
  assert.equal(f.calls.filter(c => c.kind === 'send').length, 1);
  assert.equal(f.calls.filter(c => c.kind === 'draft').length, 0);
  assert.equal(f.calls.filter(c => c.kind === 'edit').length, 3);
  assert.equal(f.calls.find(c => c.kind === 'send')!.args[2][0][0].callback_data, 'engine:stop:task');
});

test('draft failure transitions once to a persistent card and invalidates native stop correlation', async () => {
  const f = fixture(); const scope = 'telegram:42::root';
  await f.previews.begin(scope, 'task', 'thinking'); f.fail();
  assert.equal(await f.previews.update(scope, 'task', 0, 'working'), 77);
  await f.previews.update(scope, 'task', 77, 'still working');
  assert.equal(f.generations.size, 0);
  assert.equal(f.calls.filter(c => c.kind === 'send').length, 1);
  assert.equal(f.calls.filter(c => c.kind === 'edit').length, 1);
  assert.equal(f.calls.filter(c => c.kind === 'clear').length, 1);
});

test('final result renders the trusted fold as HTML and treats model HTML as text', () => {
  const result = telegramTaskResult('<blockquote expandable><b>工具小结</b></blockquote>\n\n**Done** <script>model</script>');
  assert.match(result.html!, /<blockquote expandable><b>工具小结<\/b><\/blockquote>/);
  assert.match(result.html!, /<b>Done<\/b>/);
  assert.match(result.html!, /&lt;script&gt;model&lt;\/script&gt;/);
  assert.ok(result.html!.indexOf('Done') < result.html!.indexOf('工具小结'));
  assert.equal(result.markdown, undefined);
});


test('a model-authored fold cannot introduce arbitrary HTML attributes or links', () => {
  const result = telegramTaskResult('<blockquote expandable><a href="https://unexpected.invalid">link</a><b onclick="bad">text</b></blockquote>answer');
  assert.doesNotMatch(result.html!, /<a |<b onclick=/);
  assert.match(result.html!, /&lt;a href=/);
});
