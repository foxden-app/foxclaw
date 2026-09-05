import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = fileURLToPath(new URL('../../scripts/force-takeover.py', import.meta.url));

export interface ExternalWriterIdentity {
  pid: number;
  startTime: string;
  exe: string;
  lockDevice: string;
  lockInode: string;
  cwd: string;
}

async function runHelper(home: string, threadId: string, expected?: ExternalWriterIdentity): Promise<unknown> {
  if (process.platform !== 'linux') throw new Error('Force takeover requires Linux/WSL with pidfd support');
  const args = [helper, home, threadId];
  if (expected) args.push(JSON.stringify(expected));
  const { stdout } = await execFileAsync('python3', args, { timeout: 12_000, maxBuffer: 16_384 });
  const response = JSON.parse(stdout) as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok) throw new Error(response.error ?? 'External writer inspection failed');
  return response.result;
}

export const externalWriterControl = {
  async inspect(home: string, threadId: string): Promise<ExternalWriterIdentity> {
    return await runHelper(home, threadId) as ExternalWriterIdentity;
  },
  async stop(home: string, threadId: string, expected: ExternalWriterIdentity): Promise<void> {
    const result = await runHelper(home, threadId, expected) as { stopped?: boolean };
    if (result.stopped !== true) throw new Error('CLI stop was not confirmed');
  },
};
