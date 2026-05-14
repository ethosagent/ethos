import type { RequestDumpRecord, RequestDumpStore } from '@ethosagent/types';

export class InMemoryRequestDumpStore implements RequestDumpStore {
  private records: RequestDumpRecord[] = [];

  async append(record: RequestDumpRecord): Promise<void> {
    this.records.push(record);
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
