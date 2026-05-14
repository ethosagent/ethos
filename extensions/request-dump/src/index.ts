import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestDumpRecord, RequestDumpStore } from '@ethosagent/types';

export class JsonlRequestDumpStore implements RequestDumpStore {
  private currentFile: string;
  private currentSize = 0;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxAgeHours: number;

  constructor(opts: { dir: string; maxBytes?: number; maxAgeHours?: number }) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 10_485_760; // 10MB
    this.maxAgeHours = opts.maxAgeHours ?? 24;
    this.currentFile = this.buildFilename();
  }

  private buildFilename(seq = 0): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.dir, `requests-${date}.${seq}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private shouldRotate(): boolean {
    // Rotate if current file exceeds size limit
    if (this.currentSize >= this.maxBytes) return true;
    // Rotate if date has changed (new day)
    const date = new Date().toISOString().slice(0, 10);
    if (!this.currentFile.includes(date)) return true;
    return false;
  }

  private async rotate(): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    // Find next available seq number for today
    let seq = 0;
    const files = await readdir(this.dir).catch(() => []);
    for (const f of files) {
      const m = f.match(new RegExp(`^requests-${date}\\.(\\d+)\\.jsonl$`));
      if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1);
    }
    this.currentFile = this.buildFilename(seq);
    this.currentSize = 0;
  }

  async append(record: RequestDumpRecord): Promise<void> {
    await this.ensureDir();
    if (this.shouldRotate()) await this.rotate();
    const line = JSON.stringify(record) + '\n';
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
    const files = (await readdir(this.dir).catch(() => []))
      .filter((f) => f.startsWith('requests-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const results: RequestDumpRecord[] = [];
    for (const file of files) {
      const content = await readFile(join(this.dir, file), 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        if (results.length >= opts.limit) break;
        const record: RequestDumpRecord = JSON.parse(line);
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
      if (results.length >= opts.limit) break;
    }
    return results.slice(0, opts.limit);
  }

  async close(): Promise<void> {}
}
