import { EthosError } from '@ethosagent/types';
function toMetadata(r) {
    return {
        id: r.id,
        prefix: r.prefix,
        name: r.name,
        scopes: r.scopes,
        allowedOrigins: r.allowedOrigins,
        createdAt: r.createdAt.toISOString(),
        lastUsed: r.lastUsed?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
    };
}
export class ApiKeysService {
    store;
    constructor(store) {
        this.store = store;
    }
    requireStore() {
        if (!this.store) {
            throw new EthosError({
                code: 'NOT_CONFIGURED',
                cause: 'API key store is not configured for this server.',
                action: 'Start Ethos with API key support enabled.',
            });
        }
        return this.store;
    }
    async create(input) {
        const store = this.requireStore();
        const result = await store.create({
            name: input.name,
            scopes: input.scopes,
            allowedOrigins: input.allowedOrigins,
        });
        return { secret: result.secret, key: toMetadata(result.record) };
    }
    async list() {
        const store = this.requireStore();
        const records = await store.list();
        return { items: records.map(toMetadata), nextCursor: null };
    }
    async revoke(id) {
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
        return { ok: true };
    }
}
