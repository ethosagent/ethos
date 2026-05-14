import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { AttachmentCache, Storage } from '@ethosagent/types';

function hashSession(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}

function sanitize(value: string): string {
  // Replace any char not in the safe set
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
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
    // Ensure root always ends with separator for safe prefix checks.
    const resolved = resolve(cacheRoot);
    this.root = resolved.endsWith(sep) ? resolved : resolved + sep;
  }

  async write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string> {
    const hash = hashSession(meta.sessionKey);
    const safeName = sanitize(meta.filename);
    const safeMessageId = sanitize(meta.messageId);
    const dir = join(this.root, hash, safeMessageId);
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
    // this.root always ends with sep, so this prefix check cannot be
    // fooled by paths like /tmp/cache-evil when root is /tmp/cache/.
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

    const entries = await this.storage.listEntries(this.root);

    for (const entry of entries) {
      if (!entry.isDir) continue;
      const entryPath = join(this.root, entry.name);
      const mt = await this.storage.mtime(entryPath);
      if (mt !== null && mt < cutoff) {
        try {
          await this.storage.remove(entryPath, { recursive: true });
          removedCount++;
        } catch {
          // Entry disappeared concurrently — skip.
        }
      }
    }

    return { removedCount };
  }
}
