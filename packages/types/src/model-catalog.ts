export interface ModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  default?: boolean;
}

export interface ProviderCatalog {
  models: ModelEntry[];
}

export interface ModelCatalogManifest {
  version: number;
  updatedAt: string;
  providers: Record<string, ProviderCatalog>;
}
