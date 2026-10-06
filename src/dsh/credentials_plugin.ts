import fs from 'node:fs/promises';

interface CredentialInfo { configured: boolean; writable: boolean; source?: unknown; }
interface Context {
  credentials: {
    describe(ref: string): Promise<CredentialInfo>;
    set(ref: string, value: string): Promise<void>;
  };
}

export const name = 'foxclaw-credentials';
export const inject = ['credentials'];

/** One private control request. Use DSH's native locking, validation and storage. */
export async function apply(ctx: Context, config: { requestPath: string; resultPath: string }): Promise<void> {
  let result: { ok: boolean; info?: CredentialInfo; error?: string };
  try {
    const request = JSON.parse(await fs.readFile(config.requestPath, 'utf8')) as { operation: string; value?: string };
    const ref = 'DEEPSEEK_API_KEY';
    if (request.operation === 'set') {
      if (typeof request.value !== 'string' || !/^[!-~]+$/.test(request.value)) throw new Error('Invalid key');
      await ctx.credentials.set(ref, request.value);
    } else if (request.operation !== 'describe') throw new Error('Unknown credential operation');
    const info = await ctx.credentials.describe(ref);
    result = { ok: true, info: { configured: info.configured, writable: info.writable } };
  } catch {
    // Native errors and parser diagnostics must never propagate a key value.
    result = { ok: false, error: 'DSH 无法保存或读取凭据，请检查其凭据配置及文件权限；环境提供的密钥不能在面板中覆盖。 / DSH credential operation failed. Check configuration, file permissions and environment overrides.' };
  } finally { await fs.rm(config.requestPath, { force: true }); }
  const temporary = `${config.resultPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, config.resultPath);
}
