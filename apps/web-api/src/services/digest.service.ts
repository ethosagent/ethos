import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';
import type { DigestLatest } from '@ethosagent/web-contracts';

// Digest service — read-only view of the most recent weekly governed-learning
// digest written to `<dataDir>/digests/<ISO-week>.md`. Generation runs
// out-of-band (weekly cron / `ethos digest run`); this only reads.

export interface DigestServiceOptions {
  storage: Storage;
  dataDir: string;
}

export class DigestService {
  constructor(private readonly opts: DigestServiceOptions) {}

  /**
   * Return the most recent digest, or null when none exist. The digest
   * filenames are ISO `YYYY-Www`, which sorts lexicographically by recency —
   * so the greatest `*.md` filename is the newest week.
   */
  async latest(): Promise<DigestLatest | null> {
    const { storage, dataDir } = this.opts;
    const dir = join(dataDir, 'digests');
    const entries = await storage.list(dir);
    const files = entries.filter((name) => name.endsWith('.md'));
    if (files.length === 0) return null;
    files.sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    const path = join(dir, newest);
    const markdown = await storage.read(path);
    if (markdown === null) return null;
    const mtime = await storage.mtime(path);
    return {
      label: newest.slice(0, -3),
      markdown,
      generatedAt: new Date(mtime ?? 0).toISOString(),
    };
  }
}
