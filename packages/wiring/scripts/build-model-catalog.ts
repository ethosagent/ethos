import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelCatalogManifest, ModelEntry } from '@ethosagent/types';
import { MODEL_CATALOG } from '../src/model-catalog';
import {
  fetchOpenRouterModels,
  filterByAllowlist,
  transformOpenRouterEntry,
} from './sources/openrouter';

function catalogToEntries(providerId: string): ModelEntry[] {
  return MODEL_CATALOG.filter((e) => e.providerId === providerId).map((e) => {
    const entry: ModelEntry = {
      id: e.modelId,
      label: e.label,
      contextWindow: e.contextWindow,
    };
    if (e.default) entry.default = true;
    return entry;
  });
}

async function buildOpenAICompat(): Promise<ModelEntry[]> {
  const directOpenAI = catalogToEntries('openai');

  let openRouterEntries: ModelEntry[];
  try {
    const raw = await fetchOpenRouterModels();
    const filtered = filterByAllowlist(raw);
    openRouterEntries = filtered.map(transformOpenRouterEntry);
  } catch {
    openRouterEntries = MODEL_CATALOG.filter((e) => e.providerId === 'openrouter').map((e) => ({
      id: e.modelId,
      label: `${e.label} (OR)`,
      contextWindow: e.contextWindow,
      ...(e.default ? { default: true } : {}),
    }));
  }

  const seen = new Set(directOpenAI.map((e) => e.id));
  const deduped = [...directOpenAI, ...openRouterEntries.filter((e) => !seen.has(e.id))];

  return deduped;
}

async function main() {
  const anthropic = catalogToEntries('anthropic');
  const azure = catalogToEntries('azure');
  const openaiCompat = await buildOpenAICompat();

  const manifest: ModelCatalogManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    providers: {
      anthropic: { models: anthropic },
      'openai-compat': { models: openaiCompat },
      azure: { models: azure },
    },
  };

  const outPath = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'docs',
    'static',
    'api',
    'model-catalog.json',
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Wrote ${outPath}\n`);
}

main();
