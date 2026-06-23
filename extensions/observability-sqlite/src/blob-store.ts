import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Storage } from '@ethosagent/types';

/**
 * Content-addressed gzip blob store.
 * Blobs are stored under <root>/<aa>/<rest>.gz where <aa> is the first two
 * hex characters of the SHA-256 of the uncompressed content.
 *
 * The only exception for node:fs usage (allowed per CLAUDE.md):
 *   SQLite DB files via @ethosagent/sqlite — blob-store uses Storage for all I/O.
 */
export class BlobStore {
  constructor(
    private readonly root: string,
    private readonly storage: Storage,
  ) {}

  /** Write content (compressed) and return its content-addressed key (hex SHA-256). */
  async put(content: string): Promise<string> {
    const key = sha256(content);
    const path = this.blobPath(key);
    const dir = join(this.root, key.slice(0, 2));

    // Idempotent — skip if already written.
    if (await this.storage.exists(path)) return key;

    await this.storage.mkdir(dir);
    const compressed = gzipSync(Buffer.from(content, 'utf-8'));
    // Base64-encode so the pure-ASCII result is safe through UTF-8 Storage.write.
    await this.storage.write(path, compressed.toString('base64'), { mode: 0o600 });
    return key;
  }

  /** Read and decompress a blob by key. Returns null if missing. */
  async get(key: string): Promise<string | null> {
    const path = this.blobPath(key);
    const raw = await this.storage.read(path);
    if (raw === null) return null;
    const buf = Buffer.from(raw, 'base64');
    return gunzipSync(buf).toString('utf-8');
  }

  private blobPath(key: string): string {
    return join(this.root, key.slice(0, 2), `${key}.gz`);
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
