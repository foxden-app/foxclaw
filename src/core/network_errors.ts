export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as any).message || err).toLowerCase();
  return (
    msg.includes('client network socket disconnected') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('network socket disconnected') ||
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('und_err_') ||
    msg.includes('read tcp') ||
    msg.includes('connection timed out') ||
    msg.includes('broken pipe') ||
    msg.includes('ehostunreach') ||
    msg.includes('enetunreach')
  );
}

