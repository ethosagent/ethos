// Shared fixtures for the Settings → Models registry tests. The roster is the
// approved mockup's (plan/phases/model-registry.md Phase 2, frame 1): three
// entries on two referenceable provider entries, one entry whose key is
// missing, and one provider entry with no explicit id.

import type {
  ModelProviderEntryView,
  ModelRegistryEntryView,
  ModelRegistryListResult,
} from '@ethosagent/web-contracts';
import type { ModelCatalog } from '../lib/model-registry';

export function entry(
  alias: string,
  providerKey: string,
  modelId: string,
  extra: Partial<ModelRegistryEntryView> = {},
): ModelRegistryEntryView {
  return {
    alias,
    providerKey,
    modelId,
    label: null,
    contextWindow: null,
    costPer1kInput: null,
    costPer1kOutput: null,
    fallbacks: [],
    credential: 'set',
    referents: [],
    ...extra,
  };
}

export function providerEntry(
  key: string,
  index: number,
  provider: string,
  extra: Partial<ModelProviderEntryView> = {},
): ModelProviderEntryView {
  return {
    key,
    index,
    provider,
    id: key,
    explicitId: true,
    model: null,
    failover: true,
    apiVersion: null,
    region: null,
    awsProfile: null,
    credential: 'set',
    referenceable: true,
    reason: null,
    ...extra,
  };
}

/** A provider-chain model the registry does not hold yet (`list.chainModels`). */
export function chainModel(
  extra: Partial<ModelRegistryListResult['chainModels'][number]> = {},
): ModelRegistryListResult['chainModels'][number] {
  return {
    providerKey: 'codex-gpt-terra',
    index: 0,
    provider: 'codex',
    modelId: 'gpt-5.6-terra',
    suggestedAlias: 'gpt-5-6-terra',
    idIsExplicit: true,
    ...extra,
  };
}

export function registryList(
  extra: Partial<ModelRegistryListResult> = {},
): ModelRegistryListResult {
  return {
    entries: [
      entry('sonnet', 'anthropic-work', 'claude-sonnet-5', {
        label: 'everyday driver',
        contextWindow: 200_000,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      }),
      entry('opus', 'anthropic-work', 'claude-opus-5', {
        label: 'hard problems',
        referents: [{ kind: 'role', role: 'deep' }],
      }),
      entry('qwen', 'local-ollama', 'qwen2.5-coder:32b', { credential: 'not_needed' }),
      entry('gpt', 'openai-main', 'gpt-5', { credential: 'missing' }),
    ],
    default: 'sonnet',
    roles: { trivial: null, default: null, deep: 'opus', dreaming: null },
    providerEntries: [
      providerEntry('anthropic-work', 0, 'anthropic'),
      providerEntry('local-ollama', 1, 'ollama', { credential: 'not_needed' }),
      providerEntry('openai-main', 2, 'openai', { credential: 'missing' }),
      providerEntry('anthropic', 3, 'anthropic', {
        id: null,
        explicitId: false,
        referenceable: false,
        reason: 'add an id to this entry in the provider chain',
      }),
    ],
    routing: { 'pr-reviewer': 'deep' },
    problems: [],
    chainModels: [],
    ...extra,
  };
}

export const CATALOG: ModelCatalog = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  providers: {
    anthropic: {
      models: [
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: 200_000 },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000 },
      ],
    },
    ollama: { models: [{ id: 'llama3.3:70b', label: 'Llama 3.3 70B', contextWindow: 131_072 }] },
  },
};
