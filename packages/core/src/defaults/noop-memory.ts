import type {
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  MemoryUpdate,
  SearchOpts,
} from '@ethosagent/types';

export class NoopMemoryProvider implements MemoryProvider {
  async prefetch(_ctx: MemoryContext): Promise<MemorySnapshot | null> {
    return null;
  }

  async read(_key: string, _ctx: MemoryContext): Promise<MemoryEntry | null> {
    return null;
  }

  async search(_query: string, _ctx: MemoryContext, _opts?: SearchOpts): Promise<MemoryEntry[]> {
    return [];
  }

  async sync(_updates: MemoryUpdate[], _ctx: MemoryContext): Promise<void> {
    // No-op
  }

  async list(_ctx: MemoryContext, _opts?: ListOpts): Promise<MemoryEntryRef[]> {
    return [];
  }
}
