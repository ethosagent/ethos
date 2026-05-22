import type { MemoryContext, MemoryProvider } from '@ethosagent/types';
import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';
import type { IdentityMap } from '@ethosagent/wiring';

export interface MemoryServiceOptions {
  memory: MemoryProvider;
  identityMap?: IdentityMap;
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  async list(
    personalityId: string,
    listOpts?: { userId?: string },
  ): Promise<{ items: MemoryFile[]; nextCursor: string | null }> {
    const [memoryFile, userFile] = await Promise.all([
      this.readEntry('memory', personalityId, listOpts),
      this.readEntry('user', personalityId, listOpts),
    ]);
    return { items: [memoryFile, userFile], nextCursor: null };
  }

  async get(
    store: MemoryStoreId,
    personalityId: string,
    getOpts?: { userId?: string },
  ): Promise<{ file: MemoryFile }> {
    return { file: await this.readEntry(store, personalityId, getOpts) };
  }

  async write(
    store: MemoryStoreId,
    content: string,
    personalityId: string,
    writeOpts?: { userId?: string },
  ): Promise<{ file: MemoryFile }> {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, writeOpts?.userId));
    await this.opts.memory.sync([{ action: 'replace', key, content }], ctx);
    // Re-read to return the persisted state.
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      file: {
        store,
        content: entry?.content ?? content,
        path: null,
        modifiedAt,
      },
    };
  }

  async listUsers(): Promise<{
    users: Array<{
      userId: string;
      displayLabel: string;
      platform: string;
      firstSeenAt: string;
    }>;
  }> {
    const entries = (await this.opts.identityMap?.listUsers()) ?? [];
    return {
      users: entries.map((e) => ({
        userId: e.userId,
        displayLabel: e.displayLabel,
        platform: e.platform,
        firstSeenAt: e.firstSeenAt,
      })),
    };
  }

  private async readEntry(
    store: MemoryStoreId,
    personalityId: string,
    readOpts?: { userId?: string },
  ): Promise<MemoryFile> {
    const key = store === 'memory' ? 'MEMORY.md' : 'USER.md';
    const ctx = this.buildCtx(this.scopeIdFor(store, personalityId, readOpts?.userId));
    const entry = await this.opts.memory.read(key, ctx);
    const modifiedAt = entry?.metadata?.lastUpdatedAt
      ? new Date(entry.metadata.lastUpdatedAt).toISOString()
      : null;
    return {
      store,
      content: entry?.content ?? '',
      path: null,
      modifiedAt,
    };
  }

  private scopeIdFor(store: MemoryStoreId, personalityId: string, userId?: string): string {
    if (store === 'user' && userId) return `user:${userId}`;
    return `personality:${personalityId}`;
  }

  private buildCtx(scopeId: string): MemoryContext {
    return { scopeId, sessionId: '', sessionKey: '', platform: 'web', workingDir: '' };
  }
}
