import type { ModelInfo, ModelServiceTier } from '../types.js';

export const FAST_TIER_NAME = 'fast';
export const FAST_TIER_ID = 'priority';

const DEFAULT_SERVICE_TIER_IDS = new Set(['auto', 'default', 'standard']);

export function resolveFastTierForModel(model: ModelInfo | null): ModelServiceTier | null {
  if (!model || model.serviceTiers.length === 0) {
    return null;
  }
  const byName = model.serviceTiers.find(tier => tier.name.trim().toLowerCase() === FAST_TIER_NAME);
  if (byName) {
    return byName;
  }
  const byId = model.serviceTiers.find(tier => tier.id.trim().toLowerCase() === FAST_TIER_ID);
  if (byId) {
    return byId;
  }
  return model.serviceTiers.find(tier => !DEFAULT_SERVICE_TIER_IDS.has(tier.id.trim().toLowerCase())) ?? null;
}

export function isServiceTierSupportedByModel(model: ModelInfo | null, tierId: string | null | undefined): boolean {
  if (!model || !tierId) {
    return false;
  }
  return model.serviceTiers.some(tier => tier.id === tierId);
}

export function clampServiceTierToModel(
  model: ModelInfo | null,
  currentTierId: string | null,
): { tier: string | null; adjusted: boolean } {
  if (!currentTierId) {
    return { tier: null, adjusted: false };
  }
  if (isServiceTierSupportedByModel(model, currentTierId)) {
    return { tier: currentTierId, adjusted: false };
  }
  return { tier: null, adjusted: true };
}
