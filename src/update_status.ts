type RuntimeLastUpdateStatus = {
  userAgent?: string | null;
  currentVersion?: string | null;
  lastUpdate?: {
    state: string;
    toVersion: string | null;
  } | null;
};

export function shouldShowRuntimeLastUpdate(status: RuntimeLastUpdateStatus, currentVersion: string | null = null): boolean {
  const update = status.lastUpdate;
  if (!update) {
    return false;
  }
  if (update.state !== 'succeeded') {
    return true;
  }
  const version = currentVersion?.trim() || status.currentVersion?.trim() || extractFoxClawVersionFromUserAgent(status.userAgent);
  return Boolean(version && update.toVersion === version);
}

export function extractFoxClawVersionFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) {
    return null;
  }
  const match = userAgent.match(/\(foxclaw;\s*([^)]+)\)/i);
  return match?.[1]?.trim() || null;
}
