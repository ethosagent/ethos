import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

function hashSession(sessionKey) {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}
/** Collision-resistant path segment for IDs that may contain unsafe chars. */
function hashSegment(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
function sanitize(value) {
  // Replace any char not in the safe set
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Collapse consecutive dots to prevent ".." traversal
  return safe.replace(/\.{2,}/g, '_');
}
/**
 * Production AttachmentCache backed by a Storage implementation.
 * Writes attachment bytes to `<cacheRoot>/<sessionHash>/<messageId>/<sanitizedFilename>`.
 */
export class FsAttachmentCache {
  root;
  storage;
  constructor(storage, cacheRoot) {
    this.storage = storage;
    // Ensure root always ends with separator for safe prefix checks.
    const resolved = resolve(cacheRoot);
    this.root = resolved.endsWith(sep) ? resolved : resolved + sep;
  }
  async write(bytes, meta) {
    const hash = hashSession(meta.sessionKey);
    const safeName = sanitize(meta.filename);
    const safeMessageId = hashSegment(meta.messageId);
    const dir = join(this.root, hash, safeMessageId);
    const filePath = join(dir, safeName);
    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(filePath, bytes);
    return `file://${filePath}`;
  }
  resolveLocalPath(url) {
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
  async clear(sessionKey) {
    const hash = hashSession(sessionKey);
    const sessionDir = join(this.root, hash);
    try {
      await this.storage.remove(sessionDir, { recursive: true });
    } catch {
      // Directory may not exist — swallow.
    }
  }
  async pruneOlderThan(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    let removedCount = 0;
    // Traverse <root>/<sessionHash>/ directories.
    const sessionDirs = await this.storage.listEntries(this.root);
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDir) continue;
      const sessionPath = join(this.root, sessionEntry.name);
      const mt = await this.storage.mtime(sessionPath);
      if (mt !== null && mt < cutoff) {
        try {
          await this.storage.remove(sessionPath, { recursive: true });
          removedCount++;
        } catch {
          // Entry disappeared concurrently — skip.
        }
      }
    }
    return { removedCount };
  }
}
