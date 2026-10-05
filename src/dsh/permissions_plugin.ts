import fs from 'node:fs';

/** Minimal service face so the bridge plugin needs no DSH package dependency. */
interface Session { header: { parentSession?: string }; }
interface Context {
  permissionPresets: { set(session: Session, preset: string): void };
  on(event: 'agent/created', listener: (payload: { agent: { session: Session } }) => void): void;
  on(event: 'agent/pre-step', listener: (payload: { agent: { session: Session } }, next: () => Promise<unknown>) => Promise<unknown>, options: { prepend: boolean }): void;
}

export const name = 'foxclaw-permissions';
export const inject = ['permissionPresets'];

/** Apply FoxClaw's selected native preset before fresh/restored root agents run. */
export function apply(ctx: Context, config: { policyPath: string }): void {
  const permissions = ctx.permissionPresets;
  const select = (session: Session): void => {
    if (session.header.parentSession) return;
    const preset = fs.readFileSync(config.policyPath, 'utf8').trim();
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(preset)) {
      throw new Error('Invalid FoxClaw DSH permission preset');
    }
    permissions.set(session, preset);
  };
  ctx.on('agent/created', ({ agent }) => select(agent.session));
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    select(agent.session);
    return next();
  }, { prepend: true });
}
