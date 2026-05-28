// Constitutional exception: raw node:fs used here (same class as session-sqlite
// and memory-vector). JSONL append + rotation + streaming reads require direct
// file control that the Storage interface doesn't expose (append, stat, readdir).
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
export class JsonlRequestDumpStore {
  currentFile;
  currentSize = -1;
  dir;
  maxBytes;
  constructor(opts) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 10_485_760;
    this.currentFile = this.buildFilename();
  }
  buildFilename(seq = 0) {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.dir, `requests-${date}.${seq}.jsonl`);
  }
  async ensureDir() {
    await mkdir(this.dir, { recursive: true });
  }
  async initSize() {
    if (this.currentSize >= 0) return;
    try {
      const s = await stat(this.currentFile);
      this.currentSize = s.size;
    } catch {
      this.currentSize = 0;
    }
  }
  shouldRotate() {
    if (this.currentSize >= this.maxBytes) return true;
    const date = new Date().toISOString().slice(0, 10);
    if (!this.currentFile.includes(date)) return true;
    return false;
  }
  async rotate() {
    const date = new Date().toISOString().slice(0, 10);
    let seq = 0;
    const files = await readdir(this.dir).catch(() => []);
    for (const f of files) {
      const m = f.match(new RegExp(`^requests-${date}\\.(\\d+)\\.jsonl$`));
      if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1);
    }
    this.currentFile = this.buildFilename(seq);
    this.currentSize = 0;
  }
  async append(record) {
    await this.ensureDir();
    await this.initSize();
    if (this.shouldRotate()) await this.rotate();
    const line = `${JSON.stringify(record)}\n`;
    await appendFile(this.currentFile, line, 'utf-8');
    this.currentSize += Buffer.byteLength(line);
  }
  async recent(opts) {
    await this.ensureDir();
    const files = (await readdir(this.dir).catch(() => []))
      .filter((f) => f.startsWith('requests-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    const results = [];
    for (const file of files) {
      if (results.length >= opts.limit) break;
      const content = await readFile(join(this.dir, file), 'utf-8').catch(() => '');
      const lines = content.trim().split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        if (results.length >= opts.limit) break;
        let record;
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
  async close() {}
}
