import { createHash } from 'node:crypto';
import type { AttachmentCache } from '@ethosagent/types';

interface CacheEntry {
  bytes: Uint8Array;
  sessionHash: string;
  createdAt: number;
}

const ROOT = '/tmp/ethos-test-cache/attachments';

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
 * In-memory AttachmentCache for tests. Stores bytes in a Map keyed by
 * the full cache path. No filesystem access.
 */
export class InMemoryAttachmentCache implements AttachmentCache {
  private readonly entries = new Map<string, CacheEntry>();

  async write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string> {
    const hash = hashSession(meta.sessionKey);
    const safeName = sanitizeFilename(meta.filename);
    const path = `${ROOT}/${hash}/${meta.messageId}/${safeName}`;

    this.entries.set(path, {
      bytes: new Uint8Array(bytes),
      sessionHash: hash,
      createdAt: Date.now(),
    });

    return `file://${path}`;
  }

  resolveLocalPath(url: string): string {
    if (!url.startsWith('file://')) {
      throw new Error(`Not a file:// URL: ${url}`);
    }
    const path = url.slice('file://'.length);
    if (!path.startsWith(ROOT)) {
      throw new Error(`Path outside cache root: ${path}`);
    }
    return path;
  }

  async clear(sessionKey: string): Promise<void> {
    const hash = hashSession(sessionKey);
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key);
      if (entry && entry.sessionHash === hash) {
        this.entries.delete(key);
      }
    }
  }

  async pruneOlderThan(olderThanMs: number): Promise<{ removedCount: number }> {
    const cutoff = Date.now() - olderThanMs;
    let removedCount = 0;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(key);
        removedCount++;
      }
    }
    return { removedCount };
  }

  /** Test helper — retrieve stored bytes by resolved path. */
  getBytes(path: string): Uint8Array | undefined {
    return this.entries.get(path)?.bytes;
  }
}
