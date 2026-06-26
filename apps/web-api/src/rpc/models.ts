import type { ModelCatalogManifest } from '@ethosagent/types';
import { MODEL_CATALOG } from '@ethosagent/wiring/model-catalog';
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

export function buildManifest(): ModelCatalogManifest {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    providers: groupByProvider(MODEL_CATALOG),
  };
}

// Built once at module load so the manifest (and its timestamp) is
// process-stable; the handler returns the same object on every request.
const MANIFEST = buildManifest();

export const modelsRouter = {
  catalog: os.models.catalog.handler(() => MANIFEST),
};
