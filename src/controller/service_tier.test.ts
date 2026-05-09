import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo, ModelServiceTier } from '../types.js';
import {
  FAST_TIER_ID,
  FAST_TIER_NAME,
  clampServiceTierToModel,
  isServiceTierSupportedByModel,
  resolveFastTierForModel,
} from './service_tier.js';

function model(serviceTiers: ModelServiceTier[]): ModelInfo {
  return {
    id: 'model-gpt-5',
    model: 'gpt-5',
    displayName: 'GPT-5',
    description: 'Test model',
    isDefault: true,
    supportedReasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers,
  };
}

test('resolveFastTierForModel prefers tier named fast', () => {
  const fast = { id: 'low-latency', name: FAST_TIER_NAME, description: 'Fast lane' };
  assert.deepEqual(resolveFastTierForModel(model([
    { id: FAST_TIER_ID, name: 'Priority', description: 'Priority lane' },
    fast,
  ])), fast);
});

test('resolveFastTierForModel falls back to priority id', () => {
  const priority = { id: FAST_TIER_ID, name: 'Priority', description: 'Priority lane' };
  assert.deepEqual(resolveFastTierForModel(model([
    { id: 'standard', name: 'Standard', description: 'Default' },
    priority,
  ])), priority);
});

test('resolveFastTierForModel uses the first non-default tier when only batch exists', () => {
  const batch = { id: 'batch', name: 'Batch', description: 'Batch lane' };
  assert.deepEqual(resolveFastTierForModel(model([
    { id: 'standard', name: 'Standard', description: 'Default' },
    batch,
  ])), batch);
});

test('service tier helpers treat empty arrays as unsupported', () => {
  const empty = model([]);
  assert.equal(resolveFastTierForModel(empty), null);
  assert.equal(isServiceTierSupportedByModel(empty, FAST_TIER_ID), false);
  assert.deepEqual(clampServiceTierToModel(empty, FAST_TIER_ID), { tier: null, adjusted: true });
});

test('clampServiceTierToModel clears unsupported tiers after model switch', () => {
  const withPriority = model([{ id: FAST_TIER_ID, name: 'Priority', description: 'Priority lane' }]);
  const withoutPriority = model([{ id: 'batch', name: 'Batch', description: 'Batch lane' }]);
  assert.deepEqual(clampServiceTierToModel(withPriority, FAST_TIER_ID), { tier: FAST_TIER_ID, adjusted: false });
  assert.deepEqual(clampServiceTierToModel(withoutPriority, FAST_TIER_ID), { tier: null, adjusted: true });
});

test('service tier helpers handle null model and null tier', () => {
  assert.equal(resolveFastTierForModel(null), null);
  assert.equal(isServiceTierSupportedByModel(null, FAST_TIER_ID), false);
  assert.deepEqual(clampServiceTierToModel(null, null), { tier: null, adjusted: false });
  assert.deepEqual(clampServiceTierToModel(null, FAST_TIER_ID), { tier: null, adjusted: true });
});
