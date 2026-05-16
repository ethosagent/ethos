// Constitutional exception: raw node:fs used here (same class as session-sqlite
// and memory-vector). JSONL append + rotation + streaming reads require direct
// file control that the Storage interface doesn't expose (append, stat, readdir).
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestDumpRecord, RequestDumpStore } from '@ethosagent/types';

export class JsonlRequestDumpStore implements RequestDumpStore {
  private currentFile: string;
  private currentSize = -1;
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(opts: { dir: string; maxBytes?: number }) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 10_485_760;
    this.currentFile = this.buildFilename();
  }

  private buildFilename(seq = 0): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.dir, `requests-${date}.${seq}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async initSize(): Promise<void> {
    if (this.currentSize >= 0) return;
    try {
      const s = await stat(this.currentFile);
      this.currentSize = s.size;
    } catch {
      this.currentSize = 0;
    }
  }

  private shouldRotate(): boolean {
    if (this.currentSize >= this.maxBytes) return true;
    const date = new Date().toISOString().slice(0, 10);
    if (!this.currentFile.includes(date)) return true;
    return false;
  }

  private async rotate(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    let seq = 0;
    const files = await readdir(this.dir).catch(() => [] as string[]);
    for (const f of files) {
      const m = f.match(new RegExp(`^requests-${date}\\.(\\d+)\\.jsonl$`));
      if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1);
    }
    this.currentFile = this.buildFilename(seq);
    this.currentSize = 0;
  }

  async append(record: RequestDumpRecord): Promise<void> {
    await this.ensureDir();
    await this.initSize();
    if (this.shouldRotate()) await this.rotate();
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(this.currentFile, line, 'utf-8');
    this.currentSize += Buffer.byteLength(line);
  }

  async recent(opts: {
    limit: number;
    sessionId?: string;
    since?: Date;
    includeContent?: boolean;
  }): Promise<RequestDumpRecord[]> {
    await this.ensureDir();
    const files = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((f) => f.startsWith('requests-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const results: RequestDumpRecord[] = [];
    for (const file of files) {
      if (results.length >= opts.limit) break;
      const content = await readFile(join(this.dir, file), 'utf-8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        if (results.length >= opts.limit) break;
        let record: RequestDumpRecord;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (opts.sessionId && record.sessionId !== opts.sessionId) continue;
        if (opts.since && new Date(record.timestamp) < opts.since) continue;
        if (!opts.includeContent) {
          delete record.system;
          delete record.tools;
          delete record.messages;
          delete record.responseText;
        }
        results.push(record);
      }
    }
    return results.slice(0, opts.limit);
  }

  async close(): Promise<void> {}
}
