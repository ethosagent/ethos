import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AttachmentCache, Storage } from '@ethosagent/types';

function hashSession(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}

function sanitizeFilename(filename: string): string {
  // Replace any char not in the safe set
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Collapse consecutive dots to prevent ".." traversal
  return safe.replace(/\.{2,}/g, '_');
}

/**
 * Production AttachmentCache backed by a Storage implementation.
 * Writes attachment bytes to `<cacheRoot>/<sessionHash>/<messageId>/<sanitizedFilename>`.
 */
export class FsAttachmentCache implements AttachmentCache {
  private readonly root: string;
  private readonly storage: Storage;

  constructor(storage: Storage, cacheRoot: string) {
    this.storage = storage;
    this.root = resolve(cacheRoot);
  }

  async write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string> {
    const hash = hashSession(meta.sessionKey);
    const safeName = sanitizeFilename(meta.filename);
    const dir = join(this.root, hash, meta.messageId);
    const filePath = join(dir, safeName);

    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(filePath, bytes);

    return `file://${filePath}`;
  }

  resolveLocalPath(url: string): string {
    if (!url.startsWith('file://')) {
      throw new Error(`Not a file:// URL: ${url}`);
    }
    const raw = url.slice('file://'.length);
    const absolute = resolve(raw);
    if (!absolute.startsWith(this.root)) {
      throw new Error(`Path outside cache root: ${absolute}`);
    }
    return absolute;
  }

  async clear(sessionKey: string): Promise<void> {
    const hash = hashSession(sessionKey);
    const sessionDir = join(this.root, hash);
    try {
      await this.storage.remove(sessionDir, { recursive: true });
    } catch {
      // Directory may not exist — swallow.
    }
  }

  async pruneOlderThan(olderThanMs: number): Promise<{ removedCount: number }> {
    const cutoff = Date.now() - olderThanMs;
    let removedCount = 0;

    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return { removedCount: 0 };
    }

    for (const entry of entries) {
      const entryPath = join(this.root, entry);
      try {
        const s = await stat(entryPath);
        if (s.isDirectory() && s.mtimeMs < cutoff) {
          await this.storage.remove(entryPath, { recursive: true });
          removedCount++;
        }
      } catch {
        // Entry disappeared between readdir and stat — skip.
      }
    }

    return { removedCount };
  }
}
