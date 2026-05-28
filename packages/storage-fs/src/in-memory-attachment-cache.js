import { createHash } from 'node:crypto';

const ROOT = '/tmp/ethos-test-cache/attachments';
function hashSession(sessionKey) {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}
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
 * In-memory AttachmentCache for tests. Stores bytes in a Map keyed by
 * the full cache path. No filesystem access.
 */
export class InMemoryAttachmentCache {
  entries = new Map();
  async write(bytes, meta) {
    const hash = hashSession(meta.sessionKey);
    const safeName = sanitize(meta.filename);
    const msgHash = hashSegment(meta.messageId);
    const path = `${ROOT}/${hash}/${msgHash}/${safeName}`;
    this.entries.set(path, {
      bytes: new Uint8Array(bytes),
      sessionHash: hash,
      createdAt: Date.now(),
    });
    return `file://${path}`;
  }
  resolveLocalPath(url) {
    if (!url.startsWith('file://')) {
      throw new Error(`Not a file:// URL: ${url}`);
    }
    const path = url.slice('file://'.length);
    if (!path.startsWith(ROOT)) {
      throw new Error(`Path outside cache root: ${path}`);
    }
    return path;
  }
  async clear(sessionKey) {
    const hash = hashSession(sessionKey);
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key);
      if (entry && entry.sessionHash === hash) {
        this.entries.delete(key);
      }
    }
  }
  async pruneOlderThan(olderThanMs) {
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
  getBytes(path) {
    return this.entries.get(path)?.bytes;
  }
}
