import type { ModelCatalogManifest } from '@ethosagent/types';
import { MODEL_CATALOG } from '@ethosagent/wiring/model-catalog';
import { os } from './context';

// Group the in-process MODEL_CATALOG by raw provider id (the same provider
// values the web Personality editor's provider Select uses), so the model
// picker can suggest per-selected-provider models. Free text is still
// allowed in the UI — these are suggestions, not a locked list.
function buildManifest(): ModelCatalogManifest {
  const providers: ModelCatalogManifest['providers'] = {};
  for (const entry of MODEL_CATALOG) {
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
  return { version: 1, updatedAt: new Date().toISOString(), providers };
}

export const modelsRouter = {
  catalog: os.models.catalog.handler(() => buildManifest()),
};
