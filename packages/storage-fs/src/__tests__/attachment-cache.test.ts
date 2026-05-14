import { createHash } from 'node:crypto';
import type { AttachmentCache } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { FsAttachmentCache } from '../fs-attachment-cache';
import { InMemoryAttachmentCache } from '../in-memory-attachment-cache';
import { InMemoryStorage } from '../in-memory-storage';

function sessionHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

interface CacheBackend {
  name: string;
  create: () => { cache: AttachmentCache; getBytes?: (path: string) => Uint8Array | undefined };
}

const backends: CacheBackend[] = [
  {
    name: 'InMemoryAttachmentCache',
    create: () => {
      const cache = new InMemoryAttachmentCache();
      return {
        cache,
        getBytes: (path: string) => cache.getBytes(path),
      };
    },
  },
  {
    name: 'FsAttachmentCache',
    create: () => {
      const storage = new InMemoryStorage();
      const root = '/tmp/ethos-test-cache/attachments';
      const cache = new FsAttachmentCache(storage, root);
      return { cache };
    },
  },
];

describe.each(backends)('AttachmentCache — $name', ({ create }) => {
  let cache: AttachmentCache;

  const sessionKey = 'test-session-key';
  const messageId = 'msg-001';
  const filename = 'report.pdf';
  const mime = 'application/pdf';
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

  beforeEach(() => {
    cache = create().cache;
  });

  // --- write + resolveLocalPath ---

  it('write returns file:// URL and resolveLocalPath resolves it', async () => {
    const url = await cache.write(bytes, { sessionKey, messageId, filename, mime });
    expect(url).toMatch(/^file:\/\//);

    const localPath = cache.resolveLocalPath(url);
    expect(localPath).toContain(sessionHash(sessionKey));
    expect(localPath).toContain(messageId);
    expect(localPath).toContain(filename);
  });

  it('resolveLocalPath rejects paths outside cache root', () => {
    expect(() => cache.resolveLocalPath('file:///etc/passwd')).toThrow();
  });

  it('resolveLocalPath rejects non-file:// URLs', () => {
    expect(() => cache.resolveLocalPath('http://example.com/foo')).toThrow();
  });

  // --- filename sanitization ---

  it('sanitizes dangerous filenames (no .. in resolved path)', async () => {
    const dangerousFilename = '../../../etc/passwd';
    const url = await cache.write(bytes, {
      sessionKey,
      messageId,
      filename: dangerousFilename,
      mime,
    });

    const localPath = cache.resolveLocalPath(url);
    expect(localPath).not.toContain('..');
    // The sanitized filename should only contain safe chars
    expect(localPath).toMatch(/[a-zA-Z0-9._-]+$/);
  });

  it('sanitizes filenames with special characters', async () => {
    const weirdFilename = 'hello world (1) [final]!@#$.pdf';
    const url = await cache.write(bytes, {
      sessionKey,
      messageId,
      filename: weirdFilename,
      mime,
    });

    const localPath = cache.resolveLocalPath(url);
    // Only a-zA-Z0-9._- allowed in filename portion
    const basename = localPath.split('/').pop();
    expect(basename).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it('handles index-prefixed filenames for collision awareness', async () => {
    const url = await cache.write(bytes, {
      sessionKey,
      messageId,
      filename: '0-report.pdf',
      mime,
    });

    const localPath = cache.resolveLocalPath(url);
    expect(localPath).toContain('0-report.pdf');
  });

  // --- clear ---

  it('clear removes entries for a session', async () => {
    await cache.write(bytes, { sessionKey, messageId, filename, mime });
    await cache.write(bytes, { sessionKey, messageId: 'msg-002', filename: 'other.pdf', mime });

    // Write under a different session
    const otherKey = 'other-session';
    const otherUrl = await cache.write(bytes, {
      sessionKey: otherKey,
      messageId: 'msg-003',
      filename: 'keep.pdf',
      mime,
    });

    await cache.clear(sessionKey);

    // The other session's file should still resolve
    const otherPath = cache.resolveLocalPath(otherUrl);
    expect(otherPath).toBeTruthy();
  });

  // --- pruneOlderThan ---

  it('pruneOlderThan keeps recent entries when cutoff is large', async () => {
    await cache.write(bytes, { sessionKey, messageId, filename, mime });

    // Prune with a huge window — nothing should be removed
    const result = await cache.pruneOlderThan(1_000_000_000);
    expect(result.removedCount).toBe(0);
  });

  it('pruneOlderThan returns { removedCount } shape', async () => {
    const result = await cache.pruneOlderThan(1_000);
    expect(typeof result.removedCount).toBe('number');
    expect(result.removedCount).toBe(0);
  });

  // --- path structure ---

  it('stores files under <root>/<sessionHash>/<messageId>/<sanitizedFilename>', async () => {
    const url = await cache.write(bytes, { sessionKey, messageId, filename, mime });
    const localPath = cache.resolveLocalPath(url);

    const hash = sessionHash(sessionKey);
    expect(localPath).toContain(`/${hash}/`);
    expect(localPath).toContain(`/${messageId}/`);
    expect(localPath.endsWith(`/${filename}`)).toBe(true);
  });
});

// --- InMemoryAttachmentCache-specific tests ---

describe('InMemoryAttachmentCache — specific', () => {
  it('getBytes returns written bytes', async () => {
    const cache = new InMemoryAttachmentCache();
    const bytes = new Uint8Array([1, 2, 3]);
    const url = await cache.write(bytes, {
      sessionKey: 'sk',
      messageId: 'mid',
      filename: 'test.bin',
      mime: 'application/octet-stream',
    });

    const path = cache.resolveLocalPath(url);
    const retrieved = cache.getBytes(path);
    expect(retrieved).toEqual(bytes);
  });

  it('pruneOlderThan removes old entries and keeps recent ones', async () => {
    const cache = new InMemoryAttachmentCache();
    const bytes = new Uint8Array([1, 2, 3]);

    // Write an entry, then artificially age it via Date.now mock
    const realNow = Date.now;
    const pastMs = realNow() - 60_000; // 60 seconds ago
    Date.now = () => pastMs;
    await cache.write(bytes, {
      sessionKey: 'old-session',
      messageId: 'mid-old',
      filename: 'old.bin',
      mime: 'application/octet-stream',
    });
    Date.now = realNow;

    // Write a recent entry
    await cache.write(bytes, {
      sessionKey: 'new-session',
      messageId: 'mid-new',
      filename: 'new.bin',
      mime: 'application/octet-stream',
    });

    // Prune entries older than 30 seconds — should remove the old one
    const result = await cache.pruneOlderThan(30_000);
    expect(result.removedCount).toBe(1);

    // The new entry should still be retrievable
    const newUrl = `file:///tmp/ethos-test-cache/attachments/${sessionHash('new-session')}/mid-new/new.bin`;
    expect(cache.getBytes(cache.resolveLocalPath(newUrl))).toBeDefined();

    // The old entry should be gone
    const oldUrl = `file:///tmp/ethos-test-cache/attachments/${sessionHash('old-session')}/mid-old/old.bin`;
    expect(cache.getBytes(cache.resolveLocalPath(oldUrl))).toBeUndefined();
  });

  it('clear removes all entries for a session and getBytes returns undefined', async () => {
    const cache = new InMemoryAttachmentCache();
    const bytes = new Uint8Array([1, 2, 3]);
    const sessionKey = 'clear-test';

    const url = await cache.write(bytes, {
      sessionKey,
      messageId: 'mid',
      filename: 'test.bin',
      mime: 'application/octet-stream',
    });

    const path = cache.resolveLocalPath(url);
    expect(cache.getBytes(path)).toBeDefined();

    await cache.clear(sessionKey);
    expect(cache.getBytes(path)).toBeUndefined();
  });
});
