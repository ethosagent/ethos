import type { GlobalMemoryStore } from '@ethosagent/types';
import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';

// Memory service. Three reads and one write — list, get, write — all
// over the global MEMORY.md / USER.md pair. Depends on the
// `GlobalMemoryStore` contract (in @ethosagent/types) rather than a
// concrete provider class; wiring's `createMemoryProvider` returns a
// value that satisfies it.

export interface MemoryServiceOptions {
  memory: GlobalMemoryStore;
}

export class MemoryService {
  constructor(private readonly opts: MemoryServiceOptions) {}

  async list(): Promise<{ items: MemoryFile[]; nextCursor: string | null }> {
    const [memory, user] = await Promise.all([this.read('memory'), this.read('user')]);
    return { items: [memory, user], nextCursor: null };
  }

  async get(store: MemoryStoreId): Promise<{ file: MemoryFile }> {
    return { file: await this.read(store) };
  }

  async write(store: MemoryStoreId, content: string): Promise<{ file: MemoryFile }> {
    const out = await this.opts.memory.writeGlobalEntry(store, content);
    return { file: { store, ...out } };
  }

  private async read(store: MemoryStoreId): Promise<MemoryFile> {
    const out = await this.opts.memory.readGlobalEntry(store);
    return { store, ...out };
  }
}
