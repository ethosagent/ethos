import { EthosError } from '@ethosagent/types';
import type { ApiKeyMetadata } from '@ethosagent/web-contracts';
import type { ApiKeyAdminStore, ApiKeyRecord } from '../middleware/bearer-auth';

function toMetadata(r: ApiKeyRecord): ApiKeyMetadata {
  return {
    id: r.id,
    prefix: r.prefix,
    name: r.name,
    scopes: r.scopes as ApiKeyMetadata['scopes'],
    allowedOrigins: r.allowedOrigins,
    createdAt: r.createdAt.toISOString(),
    lastUsed: r.lastUsed?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  };
}

export class ApiKeysService {
  private readonly store: ApiKeyAdminStore | null;

  constructor(store: ApiKeyAdminStore | null) {
    this.store = store;
  }

  private requireStore(): ApiKeyAdminStore {
    if (!this.store) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'API key store is not configured for this server.',
        action: 'Start Ethos with API key support enabled.',
      });
    }
    return this.store;
  }

  async create(input: {
    name: string;
    scopes: string[];
    allowedOrigins: string[];
  }): Promise<{ secret: string; key: ApiKeyMetadata }> {
    const store = this.requireStore();
    const result = await store.create({
      name: input.name,
      scopes: input.scopes,
      allowedOrigins: input.allowedOrigins,
    });
    return { secret: result.secret, key: toMetadata(result.record) };
  }

  async list(): Promise<{ keys: ApiKeyMetadata[] }> {
    const store = this.requireStore();
    const records = await store.list();
    return { keys: records.map(toMetadata) };
  }

  async revoke(id: string): Promise<{ ok: true }> {
    const store = this.requireStore();
    const records = await store.list();
    const target = records.find((r) => r.id === id);
    if (!target) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: `API key "${id}" not found.`,
        action: 'Check the key ID.',
      });
    }
    await store.revoke(target.prefix);
    return { ok: true as const };
  }
}
