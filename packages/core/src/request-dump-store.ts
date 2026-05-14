import type { RequestDumpRecord, RequestDumpStore } from '@ethosagent/types';

/**
 * Bounded in-memory request dump store for tests. Not suitable for production
 * — use JsonlRequestDumpStore (or a durable implementation) instead.
 * Caps at `maxRecords` to prevent unbounded memory growth.
 */
export class InMemoryRequestDumpStore implements RequestDumpStore {
  private records: RequestDumpRecord[] = [];
  private readonly maxRecords: number;

  constructor(opts?: { maxRecords?: number }) {
    this.maxRecords = opts?.maxRecords ?? 1000;
  }

  async append(record: RequestDumpRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  async recent(opts: {
    limit: number;
    sessionId?: string;
    since?: Date;
    includeContent?: boolean;
  }): Promise<RequestDumpRecord[]> {
    let results = [...this.records].reverse();
    if (opts.sessionId) results = results.filter((r) => r.sessionId === opts.sessionId);
    if (opts.since) {
      const sinceTs = opts.since.getTime();
      results = results.filter((r) => new Date(r.timestamp).getTime() >= sinceTs);
    }
    results = results.slice(0, opts.limit);
    if (!opts.includeContent) {
      results = results.map((r) => {
        const { system, tools, messages, responseText, ...meta } = r;
        return meta;
      });
    }
    return results;
  }

  async close(): Promise<void> {}

  getAll(): RequestDumpRecord[] {
    return this.records;
  }
}
