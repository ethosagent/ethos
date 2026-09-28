import type { ModelCatalogManifest } from '@ethosagent/types';
import { listedModels, MODEL_CATALOG } from '@ethosagent/wiring/model-catalog';
import { os } from './context';

// Group the in-process MODEL_CATALOG by raw provider id (the same provider
// values the web Personality editor's provider Select uses), so the model
// picker can suggest per-selected-provider models. Free text is still
// allowed in the UI — these are suggestions, not a locked list.
export function groupByProvider(entries: typeof MODEL_CATALOG): ModelCatalogManifest['providers'] {
  const providers: ModelCatalogManifest['providers'] = {};
  for (const entry of entries) {
    const bucket = providers[entry.providerId] ?? { models: [] };
    const model: { id: string; label: string; contextWindow: number; default?: boolean } = {
      id: entry.modelId,
      label: entry.label,
      contextWindow: entry.contextWindow,
    };
    if (entry.default) model.default = true;
    bucket.models.push(model);
    providers[entry.providerId] = bucket;
  }
  return providers;
}

// Stamped once at module load so the timestamp is process-stable.
const UPDATED_AT = new Date().toISOString();

// Rebuilt per request so a deprecated model drops out on its retirement day
// without a server restart (`listedModels`, packages/wiring/src/model-catalog.ts).
export function buildManifest(now: Date = new Date()): ModelCatalogManifest {
  return {
    version: 1,
    updatedAt: UPDATED_AT,
    providers: groupByProvider(listedModels(MODEL_CATALOG, now)),
  };
}

export const modelsRouter = {
  catalog: os.models.catalog.handler(() => buildManifest()),
};
