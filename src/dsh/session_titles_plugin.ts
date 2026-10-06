import fs from 'node:fs/promises';
import path from 'node:path';

interface SessionQuery {
  readTitle(id: string): Promise<{ title: string } | undefined>;
  readSession(id: string): Promise<{ events: Array<{ type: string; data: { source?: { kind: string }; content?: Array<{ type: string; text?: string }> } }> }>;
}
interface Context {
  sessionQuery: SessionQuery;
  sessions?: { get(id: string): unknown; flush(session: unknown): Promise<unknown> };
  sessionTitle?: { rename(session: unknown, title: string): { title: string } };
  effect(callback: () => () => Promise<void>): void;
}

export const name = 'foxclaw-session-titles';
export const inject = ['sessionQuery', 'sessions', 'sessionTitle'];

/** Read native log-backed names without resuming sessions or invoking a model. */
export async function readSessionTitle(query: SessionQuery, id: string): Promise<string | undefined> {
  const title = (await query.readTitle(id))?.title;
  if (title?.trim()) return title;
  const { events } = await query.readSession(id);
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
    const text = event.data.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ');
    if (text?.trim()) return Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 120).join('');
  }
  return undefined;
}

/** A private, per-process mailbox supplements ACP versions that omit titles. */
export async function apply(ctx: Context, config: { directory: string }): Promise<void> {
  await fs.mkdir(config.directory, { recursive: true, mode: 0o700 });
  let active: Promise<void> | undefined;
  let stopped = false;
  const poll = async (): Promise<void> => {
    for (const file of await fs.readdir(config.directory)) {
      if (!/^[a-f0-9-]+\.request$/.test(file)) continue;
      const requestPath = path.join(config.directory, file);
      const responsePath = requestPath.replace(/\.request$/, '.response');
      let response: unknown = {};
      try {
        const request: unknown = JSON.parse(await fs.readFile(requestPath, 'utf8'));
        if (Array.isArray(request)) {
          if (request.length > 1000 || !request.every(id => typeof id === 'string')) throw new Error('Invalid session title request');
          const results = await Promise.allSettled(request.map(async id => ({ id, title: await readSessionTitle(ctx.sessionQuery, id) })));
          const titles: Record<string, string> = Object.create(null);
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.title) titles[result.value.id] = result.value.title;
          }
          response = titles;
        } else {
          const rename = request as { operation?: unknown; sessionId?: unknown; title?: unknown };
          if (rename?.operation !== 'rename' || typeof rename.sessionId !== 'string' || typeof rename.title !== 'string') throw new Error('Invalid rename request');
          const session = ctx.sessions?.get(rename.sessionId);
          if (!session || !ctx.sessionTitle) throw new Error('DSH session is unavailable for rename');
          const accepted = ctx.sessionTitle.rename(session, rename.title);
          await ctx.sessions!.flush(session);
          response = { ok: true, title: accepted.title };
        }
      } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : 'DSH title operation failed' }; }
      if (!stopped) {
        await fs.writeFile(`${responsePath}.tmp`, JSON.stringify(response), { mode: 0o600 });
        await fs.rename(`${responsePath}.tmp`, responsePath);
      }
      await fs.rm(requestPath, { force: true });
    }
  };
  const timer = setInterval(() => {
    if (!active) active = poll().catch(() => {}).finally(() => { active = undefined; });
  }, 50);
  ctx.effect(() => async () => {
    stopped = true;
    clearInterval(timer);
    await active;
    await fs.rm(path.join(config.directory, 'ready'), { force: true });
  });
  await fs.writeFile(path.join(config.directory, 'ready'), '', { mode: 0o600 });
}
