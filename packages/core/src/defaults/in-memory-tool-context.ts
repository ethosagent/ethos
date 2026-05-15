import type { KeyValueStore, ToolContext } from '@ethosagent/types';

export interface InMemoryToolContextOptions {
  sessionId?: string;
  sessionKey?: string;
  platform?: string;
  workingDir?: string;
  personalityId?: string;
  currentTurn?: number;
  messageCount?: number;
  resultBudgetChars?: number;
  withStorage?: boolean;
}

class InMemoryKeyValueStore implements KeyValueStore {
  private data = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void> {
    const expiresAt = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1_000 : undefined;
    this.data.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

export function makeTestToolContext(opts?: InMemoryToolContextOptions): ToolContext {
  const ctx: ToolContext = {
    sessionId: opts?.sessionId ?? 'test-session',
    sessionKey: opts?.sessionKey ?? 'cli:test',
    platform: opts?.platform ?? 'cli',
    workingDir: opts?.workingDir ?? '/tmp',
    personalityId: opts?.personalityId,
    currentTurn: opts?.currentTurn ?? 1,
    messageCount: opts?.messageCount ?? 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: opts?.resultBudgetChars ?? 80_000,
  };

  if (opts?.withStorage) {
    ctx.kvStore = new InMemoryKeyValueStore();
  }

  return ctx;
}
