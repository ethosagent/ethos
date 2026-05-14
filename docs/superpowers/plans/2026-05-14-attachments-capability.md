# Inbound Attachments Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift "user-attached file" from a per-adapter feature into a typed framework primitive so tools work identically across every channel adapter.

**Architecture:** Adapters write bytes into an `AttachmentCache`, producing `file://` URLs. `AgentLoop` annotates the user prompt with `<attachments>`. Tools that declare `capabilities.attachments` get `ctx.attachments` with `list()` / `open()` / `openByRef()`. v1 ships image + file kinds; audio/video deferred.

**Tech Stack:** TypeScript 6, vitest 4, node:crypto (sha256), Storage/FsStorage from `@ethosagent/storage-fs`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `packages/types/src/platform.ts` | Tighten `Attachment` (remove `data`, add `ref`, narrow type) |
| Modify | `packages/types/src/storage.ts` | Add `AttachmentCache` interface |
| Modify | `packages/types/src/tool-capabilities.ts` | Add `attachments` field to `ToolCapabilities`, `ScopedAttachments` interface |
| Modify | `packages/types/src/tool.ts` | Add `attachments?` to `ToolContext` |
| Modify | `packages/types/src/index.ts` | Re-export new types |
| Create | `packages/storage-fs/src/fs-attachment-cache.ts` | `FsAttachmentCache` implementation |
| Create | `packages/storage-fs/src/in-memory-attachment-cache.ts` | Test double |
| Modify | `packages/storage-fs/src/index.ts` | Export new cache classes |
| Create | `packages/core/src/scoped/scoped-attachments.ts` | `ScopedAttachmentsImpl` |
| Modify | `packages/core/src/scoped/index.ts` | Export `ScopedAttachmentsImpl` |
| Modify | `packages/core/src/capability-resolver.ts` | Wire `attachments` into `resolveCapabilities` |
| Modify | `packages/core/src/agent-loop.ts` | `RunOptions.attachments`, prompt annotation, thread into resolver |
| Modify | `extensions/gateway/src/index.ts` | Forward `message.attachments` to `loop.run` |
| Modify | `extensions/platform-telegram/src/index.ts` | Migrate to `url: file://`, narrow to image+file |
| Modify | `extensions/platform-slack/src/routing/triage.ts` | Allow `file_share` subtype |
| Modify | `extensions/platform-slack/src/adapter.ts` | File extraction + download + cache |
| Modify | `extensions/tools-vision/src/index.ts` | Declare `attachments` capability, add `ref` arg |
| Modify | `extensions/tools-file/src/index.ts` | Declare `attachments` capability, add `ref` arg |
| Modify | `apps/ethos/src/commands/chat.ts` | `/attach <path>` slash command |

## Task 1: Tighten `Attachment` type and add `AttachmentCache` interface

**Files:**
- Modify: `packages/types/src/platform.ts:1-7`
- Modify: `packages/types/src/storage.ts` (append)
- Modify: `packages/types/src/index.ts` (re-export)
- Test: `packages/types/src/__tests__/attachment-shape.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/types/src/__tests__/attachment-shape.test.ts
import { describe, expect, it } from 'vitest';
import type { Attachment, AttachmentCache } from '../index';

describe('Attachment shape', () => {
  it('requires url and ref, has no data field', () => {
    const att: Attachment = {
      type: 'image',
      ref: 'att-0',
      url: 'file:///tmp/cache/abc/img.jpg',
      mimeType: 'image/jpeg',
    };
    expect(att.ref).toBe('att-0');
    expect(att.url).toBe('file:///tmp/cache/abc/img.jpg');
    expect('data' in att).toBe(false);
  });

  it('type union is image | file', () => {
    const img: Attachment = { type: 'image', ref: 'att-0', url: 'file:///a', mimeType: 'image/png' };
    const doc: Attachment = { type: 'file', ref: 'att-1', url: 'file:///b', mimeType: 'application/pdf' };
    expect(img.type).toBe('image');
    expect(doc.type).toBe('file');
  });
});

describe('AttachmentCache interface', () => {
  it('is importable as a type', () => {
    const _check: AttachmentCache | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run packages/types/src/__tests__/attachment-shape.test.ts`
Expected: FAIL — `Attachment` still has `data?: Buffer` and no `ref`, `AttachmentCache` doesn't exist.

- [ ] **Step 3: Tighten `Attachment` in platform.ts**

Replace lines 1-7 of `packages/types/src/platform.ts`:

```ts
export interface Attachment {
  type: 'image' | 'file';
  ref: string;
  url: string;
  mimeType: string;
  filename?: string;
  sizeBytes?: number;
}
```

- [ ] **Step 4: Add `AttachmentCache` to storage.ts**

Append to `packages/types/src/storage.ts`:

```ts
export interface AttachmentCache {
  write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string>;
  clear(sessionKey: string): Promise<void>;
  pruneOlderThan(olderThanMs: number): Promise<{ removedCount: number }>;
  resolveLocalPath(url: string): string;
}
```

- [ ] **Step 5: Re-export from barrel**

In `packages/types/src/index.ts`, ensure `AttachmentCache` is exported (it should be via `export * from './storage'`). Verify `Attachment` is exported via `export * from './platform'`.

- [ ] **Step 6: Fix all compile errors from tightened Attachment**

Run `npx tsc --noEmit -p tsconfig.json`. Every file referencing `att.data` or `att.url?` will break. Fix each:
- `extensions/platform-telegram/src/index.ts` — will be migrated in Task 7, add temporary `as any` casts if needed to unblock typecheck
- Any other consumers of `Attachment.data` — grep for `.data` usage on Attachment instances

- [ ] **Step 7: Run test to verify it passes**

Run: `node_modules/.bin/vitest run packages/types/src/__tests__/attachment-shape.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```
git add packages/types/
git commit -m "feat(types): tighten Attachment (url required, ref added, data removed) and add AttachmentCache interface"
```

---

## Task 2: Implement `FsAttachmentCache` and `InMemoryAttachmentCache`

**Files:**
- Create: `packages/storage-fs/src/fs-attachment-cache.ts`
- Create: `packages/storage-fs/src/in-memory-attachment-cache.ts`
- Modify: `packages/storage-fs/src/index.ts`
- Test: `packages/storage-fs/src/__tests__/attachment-cache.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/storage-fs/src/__tests__/attachment-cache.test.ts
import { describe, expect, it } from 'vitest';
import { InMemoryAttachmentCache } from '../in-memory-attachment-cache';

describe('InMemoryAttachmentCache', () => {
  it('write returns a file:// URL and resolveLocalPath resolves it', async () => {
    const cache = new InMemoryAttachmentCache();
    const bytes = new TextEncoder().encode('hello');
    const url = await cache.write(bytes, {
      sessionKey: 'cli:test',
      messageId: 'msg-1',
      filename: 'doc.txt',
      mime: 'text/plain',
    });
    expect(url.startsWith('file://')).toBe(true);
    const path = cache.resolveLocalPath(url);
    expect(path).toContain('doc.txt');
  });

  it('resolveLocalPath rejects paths outside cache root', () => {
    const cache = new InMemoryAttachmentCache();
    expect(() => cache.resolveLocalPath('file:///etc/passwd')).toThrow();
  });

  it('normalizes dangerous filenames', async () => {
    const cache = new InMemoryAttachmentCache();
    const url = await cache.write(new Uint8Array([1]), {
      sessionKey: 'sess',
      messageId: 'msg',
      filename: '../../../etc/passwd',
      mime: 'text/plain',
    });
    const path = cache.resolveLocalPath(url);
    expect(path).not.toContain('..');
  });

  it('clear removes all entries for a session', async () => {
    const cache = new InMemoryAttachmentCache();
    await cache.write(new Uint8Array([1]), {
      sessionKey: 'sess-a',
      messageId: 'msg',
      filename: 'f.txt',
      mime: 'text/plain',
    });
    await cache.clear('sess-a');
    // After clear, resolving old URLs should throw
  });

  it('pruneOlderThan removes old entries', async () => {
    const cache = new InMemoryAttachmentCache();
    await cache.write(new Uint8Array([1]), {
      sessionKey: 'sess',
      messageId: 'msg',
      filename: 'f.txt',
      mime: 'text/plain',
    });
    const result = await cache.pruneOlderThan(0);
    expect(result.removedCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run packages/storage-fs/src/__tests__/attachment-cache.test.ts`

- [ ] **Step 3: Implement `InMemoryAttachmentCache`**

```ts
// packages/storage-fs/src/in-memory-attachment-cache.ts
import { createHash } from 'node:crypto';
import type { AttachmentCache } from '@ethosagent/types';

const SAFE_FILENAME = /[^a-zA-Z0-9._-]/g;

function hashSession(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}

function sanitizeFilename(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, '').replace(SAFE_FILENAME, '_');
  return base || 'unnamed';
}

interface CacheEntry {
  bytes: Uint8Array;
  sessionHash: string;
  createdAt: number;
}

export class InMemoryAttachmentCache implements AttachmentCache {
  private readonly root = '/tmp/ethos-test-cache/attachments';
  private readonly entries = new Map<string, CacheEntry>();

  async write(
    bytes: Uint8Array,
    meta: { sessionKey: string; messageId: string; filename: string; mime: string },
  ): Promise<string> {
    const sessionHash = hashSession(meta.sessionKey);
    const safeName = sanitizeFilename(meta.filename);
    const path = `${this.root}/${sessionHash}/${meta.messageId}/${safeName}`;
    this.entries.set(path, { bytes, sessionHash, createdAt: Date.now() });
    return `file://${path}`;
  }

  async clear(sessionKey: string): Promise<void> {
    const hash = hashSession(sessionKey);
    for (const [path, entry] of this.entries) {
      if (entry.sessionHash === hash) this.entries.delete(path);
    }
  }

  async pruneOlderThan(olderThanMs: number): Promise<{ removedCount: number }> {
    const cutoff = Date.now() - olderThanMs;
    let count = 0;
    for (const [path, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(path);
        count++;
      }
    }
    return { removedCount: count };
  }

  resolveLocalPath(url: string): string {
    if (!url.startsWith('file://')) throw new Error(`Not a file URL: ${url}`);
    const path = url.slice('file://'.length);
    if (!path.startsWith(this.root)) {
      throw new Error(`Path "${path}" is outside cache root "${this.root}"`);
    }
    return path;
  }

  getBytes(path: string): Uint8Array | undefined {
    return this.entries.get(path)?.bytes;
  }
}
```

- [ ] **Step 4: Implement `FsAttachmentCache`**

```ts
// packages/storage-fs/src/fs-attachment-cache.ts
import { createHash } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AttachmentCache, Storage } from '@ethosagent/types';

const SAFE_FILENAME = /[^a-zA-Z0-9._-]/g;

function hashSession(sessionKey: string): string {
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16);
}

function sanitizeFilename(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, '').replace(SAFE_FILENAME, '_');
  return base || 'unnamed';
}

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
    const sessionHash = hashSession(meta.sessionKey);
    const safeName = sanitizeFilename(meta.filename);
    const dir = join(this.root, sessionHash, meta.messageId);
    await this.storage.mkdir(dir);
    const path = join(dir, safeName);
    await this.storage.writeAtomic(path, bytes);
    return `file://${path}`;
  }

  async clear(sessionKey: string): Promise<void> {
    const sessionHash = hashSession(meta.sessionKey);
    const dir = join(this.root, sessionHash);
    await this.storage.remove(dir, { recursive: true }).catch(() => {});
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
    for (const sessionDir of entries) {
      const dirPath = join(this.root, sessionDir);
      try {
        const s = await stat(dirPath);
        if (s.isDirectory() && s.mtimeMs < cutoff) {
          await this.storage.remove(dirPath, { recursive: true });
          removedCount++;
        }
      } catch {
        // skip
      }
    }
    return { removedCount };
  }

  resolveLocalPath(url: string): string {
    if (!url.startsWith('file://')) throw new Error(`Not a file URL: ${url}`);
    const path = resolve(url.slice('file://'.length));
    if (!path.startsWith(this.root)) {
      throw new Error(`Path "${path}" is outside cache root "${this.root}"`);
    }
    return path;
  }
}
```

Note: fix the `clear` method — it references `meta` but should use the `sessionKey` parameter:
```ts
async clear(sessionKey: string): Promise<void> {
  const sessionHash = hashSession(sessionKey);
  const dir = join(this.root, sessionHash);
  await this.storage.remove(dir, { recursive: true }).catch(() => {});
}
```

- [ ] **Step 5: Export from barrel**

In `packages/storage-fs/src/index.ts`, add:
```ts
export { FsAttachmentCache } from './fs-attachment-cache';
export { InMemoryAttachmentCache } from './in-memory-attachment-cache';
```

- [ ] **Step 6: Run tests**

Run: `node_modules/.bin/vitest run packages/storage-fs/src/__tests__/attachment-cache.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```
git add packages/storage-fs/
git commit -m "feat(storage-fs): implement FsAttachmentCache and InMemoryAttachmentCache"
```

---

## Task 3: Extend capability framework — `ToolCapabilities.attachments` + `ScopedAttachments` + `ctx.attachments`

**Files:**
- Modify: `packages/types/src/tool-capabilities.ts:5-22` (add `attachments` field + `ScopedAttachments` interface)
- Modify: `packages/types/src/tool.ts:31-101` (add `attachments?` to `ToolContext`)
- Create: `packages/core/src/scoped/scoped-attachments.ts`
- Modify: `packages/core/src/scoped/index.ts`
- Modify: `packages/core/src/capability-resolver.ts:14-113`
- Test: `packages/core/src/__tests__/scoped-attachments.test.ts` (new)

- [ ] **Step 1: Add `attachments` to `ToolCapabilities` and `ScopedAttachments` interface**

In `packages/types/src/tool-capabilities.ts`, add to the `ToolCapabilities` interface:
```ts
  attachments?: {
    kinds: ('image' | 'file')[] | '*';
  };
```

Add the `ScopedAttachments` interface after `ScopedProcess`:
```ts
export interface ScopedAttachments {
  list(): Attachment[];
  open(att: Attachment): Promise<{ path: string }>;
  openByRef(ref: string): Promise<{ path: string }>;
}
```

Add the import: `import type { Attachment } from './platform';`

- [ ] **Step 2: Add `attachments?` to `ToolContext`**

In `packages/types/src/tool.ts`, add after `scopedProcess`:
```ts
  attachments?: import('./tool-capabilities').ScopedAttachments;
```

- [ ] **Step 3: Write failing test for ScopedAttachmentsImpl**

```ts
// packages/core/src/__tests__/scoped-attachments.test.ts
import { describe, expect, it } from 'vitest';
import type { Attachment } from '@ethosagent/types';
import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import { ScopedAttachmentsImpl } from '../scoped/scoped-attachments';

const IMAGE_ATT: Attachment = {
  type: 'image',
  ref: 'att-0',
  url: 'file:///tmp/ethos-test-cache/attachments/abc/msg-1/photo.jpg',
  mimeType: 'image/jpeg',
  filename: 'photo.jpg',
};

const FILE_ATT: Attachment = {
  type: 'file',
  ref: 'att-1',
  url: 'file:///tmp/ethos-test-cache/attachments/abc/msg-1/report.pdf',
  mimeType: 'application/pdf',
  filename: 'report.pdf',
};

describe('ScopedAttachmentsImpl', () => {
  it('list() filters by declared kinds', () => {
    const cache = new InMemoryAttachmentCache();
    const scoped = new ScopedAttachmentsImpl([IMAGE_ATT, FILE_ATT], ['image'], cache);
    expect(scoped.list()).toEqual([IMAGE_ATT]);
  });

  it('list() returns all when kinds is *', () => {
    const cache = new InMemoryAttachmentCache();
    const scoped = new ScopedAttachmentsImpl([IMAGE_ATT, FILE_ATT], '*', cache);
    expect(scoped.list()).toEqual([IMAGE_ATT, FILE_ATT]);
  });

  it('open() resolves file:// URL to a path', async () => {
    const cache = new InMemoryAttachmentCache();
    // Pre-populate the cache so resolveLocalPath works
    await cache.write(new Uint8Array([1, 2, 3]), {
      sessionKey: 'test',
      messageId: 'msg-1',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
    });
    // Get the actual URL from write
    const url = await cache.write(new Uint8Array([1, 2, 3]), {
      sessionKey: 'test',
      messageId: 'msg-1',
      filename: 'photo.jpg',
      mime: 'image/jpeg',
    });
    const att: Attachment = { type: 'image', ref: 'att-0', url, mimeType: 'image/jpeg' };
    const scoped = new ScopedAttachmentsImpl([att], ['image'], cache);
    const result = await scoped.open(att);
    expect(result.path).toContain('photo.jpg');
  });

  it('openByRef() finds by ref and opens', async () => {
    const cache = new InMemoryAttachmentCache();
    const url = await cache.write(new Uint8Array([1]), {
      sessionKey: 'test',
      messageId: 'msg',
      filename: 'f.txt',
      mime: 'text/plain',
    });
    const att: Attachment = { type: 'file', ref: 'att-0', url, mimeType: 'text/plain' };
    const scoped = new ScopedAttachmentsImpl([att], '*', cache);
    const result = await scoped.openByRef('att-0');
    expect(result.path).toContain('f.txt');
  });

  it('openByRef() throws for unknown ref', async () => {
    const cache = new InMemoryAttachmentCache();
    const scoped = new ScopedAttachmentsImpl([], '*', cache);
    await expect(scoped.openByRef('att-99')).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Implement `ScopedAttachmentsImpl`**

```ts
// packages/core/src/scoped/scoped-attachments.ts
import type { Attachment, AttachmentCache, ScopedAttachments } from '@ethosagent/types';

export class ScopedAttachmentsImpl implements ScopedAttachments {
  private readonly attachments: Attachment[];
  private readonly cache: AttachmentCache;

  constructor(
    allAttachments: Attachment[],
    kinds: ('image' | 'file')[] | '*',
    cache: AttachmentCache,
  ) {
    this.cache = cache;
    this.attachments =
      kinds === '*' ? allAttachments : allAttachments.filter((a) => kinds.includes(a.type));
  }

  list(): Attachment[] {
    return this.attachments;
  }

  async open(att: Attachment): Promise<{ path: string }> {
    if (att.url.startsWith('file://')) {
      return { path: this.cache.resolveLocalPath(att.url) };
    }
    throw new Error(`Unsupported URL scheme: ${att.url}`);
  }

  async openByRef(ref: string): Promise<{ path: string }> {
    const att = this.attachments.find((a) => a.ref === ref);
    if (!att) throw new Error(`No attachment with ref "${ref}"`);
    return this.open(att);
  }
}
```

- [ ] **Step 5: Export from scoped barrel**

In `packages/core/src/scoped/index.ts`, add:
```ts
export { ScopedAttachmentsImpl } from './scoped-attachments';
```

- [ ] **Step 6: Wire into capability resolver**

In `packages/core/src/capability-resolver.ts`:

Add to `CapabilityBackends`:
```ts
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  inboundAttachments?: import('@ethosagent/types').Attachment[];
```

Add to `ResolvedFields` Pick:
```ts
type ResolvedFields = Partial<
  Pick<ToolContext, 'kvStore' | 'secretsResolver' | 'scopedFetch' | 'scopedFs' | 'scopedProcess' | 'attachments'>
>;
```

Add to `resolveCapabilities` body, after `process` block:
```ts
  if (capabilities.attachments && backends.attachmentCache && backends.inboundAttachments) {
    result.attachments = new ScopedAttachmentsImpl(
      backends.inboundAttachments,
      capabilities.attachments.kinds,
      backends.attachmentCache,
    );
  }
```

Add import:
```ts
import { ScopedAttachmentsImpl } from './scoped/scoped-attachments';
```

- [ ] **Step 7: Run tests**

Run: `node_modules/.bin/vitest run packages/core/src/__tests__/scoped-attachments.test.ts`
Expected: PASS

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean

- [ ] **Step 8: Commit**

```
git add packages/types/ packages/core/
git commit -m "feat(core): add ScopedAttachments and wire attachments into capability resolver"
```

---

## Task 4: AgentLoop wiring — `RunOptions.attachments`, prompt annotation, gateway forwarding

**Files:**
- Modify: `packages/core/src/agent-loop.ts` (RunOptions, annotation, thread to resolver)
- Modify: `extensions/gateway/src/index.ts:943` (forward attachments)
- Test: `packages/core/src/__tests__/attachments-annotation.test.ts` (new)

- [ ] **Step 1: Write failing test for annotation**

```ts
// packages/core/src/__tests__/attachments-annotation.test.ts
import { describe, expect, it } from 'vitest';
import type { Attachment } from '@ethosagent/types';

// Import the annotation helper (will be created in step 3)
import { buildAttachmentAnnotation } from '../attachment-annotation';

describe('buildAttachmentAnnotation', () => {
  it('produces XML annotation with ref, mime, size, filename', () => {
    const atts: Attachment[] = [
      { type: 'image', ref: 'att-0', url: 'file:///cache/a/photo.jpg', mimeType: 'image/jpeg', filename: 'receipt.jpg', sizeBytes: 319488 },
    ];
    const result = buildAttachmentAnnotation(atts);
    expect(result).toContain('<attachments>');
    expect(result).toContain('ref="att-0"');
    expect(result).toContain('mime="image/jpeg"');
    expect(result).toContain('filename="receipt.jpg"');
    expect(result).toContain('</attachments>');
  });

  it('returns empty string for no attachments', () => {
    expect(buildAttachmentAnnotation([])).toBe('');
  });

  it('formats size as human-readable', () => {
    const atts: Attachment[] = [
      { type: 'file', ref: 'att-0', url: 'file:///x', mimeType: 'application/pdf', sizeBytes: 1258291 },
    ];
    const result = buildAttachmentAnnotation(atts);
    expect(result).toContain('size="1.2MB"');
  });
});
```

- [ ] **Step 2: Implement annotation helper**

```ts
// packages/core/src/attachment-annotation.ts
import type { Attachment } from '@ethosagent/types';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function buildAttachmentAnnotation(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map((a) => {
    const parts = [`ref="${a.ref}"`, `mime="${a.mimeType}"`];
    if (a.sizeBytes !== undefined) parts.push(`size="${formatSize(a.sizeBytes)}"`);
    if (a.filename) parts.push(`filename="${a.filename}"`);
    return `  <file ${parts.join(' ')} />`;
  });
  return `<attachments>\n${lines.join('\n')}\n</attachments>`;
}
```

- [ ] **Step 3: Run annotation test**

Run: `node_modules/.bin/vitest run packages/core/src/__tests__/attachments-annotation.test.ts`
Expected: PASS

- [ ] **Step 4: Extend `RunOptions` in agent-loop.ts**

Add to `RunOptions` interface:
```ts
  attachments?: import('@ethosagent/types').Attachment[];
```

- [ ] **Step 5: Prepend annotation to user message in `run()`**

In `AgentLoop.run()`, where the user text is assembled into the user message (find the line where `text` is used to build the user message to the LLM), prepend the annotation:

```ts
import { buildAttachmentAnnotation } from './attachment-annotation';

// In the run method, before the text is sent to the LLM:
const annotation = buildAttachmentAnnotation(opts.attachments ?? []);
const userText = annotation ? `${annotation}\n${text}` : text;
```

- [ ] **Step 6: Thread attachments into capability resolver**

In AgentLoop, where `resolveCapabilities` is called for each tool execution, pass `inboundAttachments` via `CapabilityBackends`:

```ts
// In the tool execution section of agent-loop.ts:
backends.inboundAttachments = opts.attachments;
```

- [ ] **Step 7: Forward attachments in gateway**

In `extensions/gateway/src/index.ts:943`, change:
```ts
for await (const event of bot.loop.run(text, {
  sessionKey,
  personalityId,
  abortSignal: signal,
})) {
```
to:
```ts
for await (const event of bot.loop.run(text, {
  sessionKey,
  personalityId,
  abortSignal: signal,
  attachments: message.attachments,
})) {
```

- [ ] **Step 8: Run typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.json`
Run: `node_modules/.bin/vitest run packages/core/src/__tests__/`
Expected: clean

- [ ] **Step 9: Commit**

```
git add packages/core/ extensions/gateway/
git commit -m "feat(core): wire attachments through AgentLoop — RunOptions, prompt annotation, gateway forwarding"
```

---

## Task 5: Telegram adapter migration

**Files:**
- Modify: `extensions/platform-telegram/src/index.ts`
- Test: `extensions/platform-telegram/src/__tests__/` (update existing)

- [ ] **Step 1: Read the current Telegram adapter**

Read `extensions/platform-telegram/src/index.ts` fully. Understand:
- `extractMedia()` — returns `MediaDescriptor[]` with `type`, `fileId`, `fileSize`, etc.
- `downloadTelegramFile()` — downloads bytes via Telegram API
- Where `attachments` are populated on `InboundMessage` (around line 640)
- The constructor shape

- [ ] **Step 2: Add `cache: AttachmentCache` to constructor**

Add `cache: AttachmentCache` to the adapter's constructor options. Store as `this.cache`.

- [ ] **Step 3: Narrow `extractMedia` to image+file only**

Modify `extractMedia()` to only return entries for:
- `photo[]` → `type: 'image'`
- `document` → `type: 'file'`

Drop branches for `voice`, `audio`, `video`, `video_note`, `animation`, `sticker`.

- [ ] **Step 4: Switch from `data: Buffer` to `url: file://`**

Where attachments are populated, replace:
```ts
attachments.push({ type, data: bytes, mimeType, filename });
```
with:
```ts
const url = await this.cache.write(new Uint8Array(bytes), {
  sessionKey,
  messageId: String(msg.message_id),
  filename: filename ?? `att-${i}.${ext}`,
  mime: mimeType,
});
attachments.push({
  type,
  ref: `att-${i}`,
  url,
  mimeType,
  filename,
  sizeBytes: bytes.length,
});
```

- [ ] **Step 5: Update tests**

Update existing Telegram tests to:
- Construct the adapter with `InMemoryAttachmentCache`
- Assert `attachments[i].url` starts with `file://`
- Assert `attachments[i].ref` matches `att-N`
- Assert no `data` field on attachments
- Add a test for voice message → empty attachments (caption preserved)

- [ ] **Step 6: Run tests + typecheck**

Run: `node_modules/.bin/vitest run extensions/platform-telegram/`
Run: `npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 7: Commit**

```
git add extensions/platform-telegram/
git commit -m "feat(telegram): migrate attachments to file:// URLs via AttachmentCache, narrow to image+file"
```

---

## Task 6: Slack adapter — file_share triage + file extraction

**Files:**
- Modify: `extensions/platform-slack/src/routing/triage.ts:54`
- Modify: `extensions/platform-slack/src/adapter.ts`
- Test: `extensions/platform-slack/src/__tests__/file-attachments.test.ts` (new)

- [ ] **Step 1: Allow `file_share` through triage**

In `extensions/platform-slack/src/routing/triage.ts:54`, change:
```ts
if (msg.subtype) return { drop: 'subtype', effectiveMode: channelMode };
```
to:
```ts
if (msg.subtype && msg.subtype !== 'file_share') return { drop: 'subtype', effectiveMode: channelMode };
```

- [ ] **Step 2: Add `cache: AttachmentCache` to Slack adapter constructor**

- [ ] **Step 3: Implement file extraction in the inbound handler**

When building `InboundMessage`, check for `event.files[]`:
```ts
const attachments: Attachment[] = [];
if (event.files) {
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg']);
  for (let i = 0; i < event.files.length; i++) {
    const file = event.files[i];
    if (file.size > 25 * 1024 * 1024) continue;
    const type = IMAGE_EXTS.has(file.filetype?.toLowerCase() ?? '') ? 'image' : 'file';
    // Skip audio/video in v1
    if (['mp3', 'mp4', 'mov', 'webm', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(file.filetype?.toLowerCase() ?? '')) continue;
    const res = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const url = await this.cache.write(bytes, {
      sessionKey,
      messageId: event.ts,
      filename: file.name ?? `att-${i}`,
      mime: file.mimetype ?? 'application/octet-stream',
    });
    attachments.push({
      type,
      ref: `att-${i}`,
      url,
      mimeType: file.mimetype ?? 'application/octet-stream',
      filename: file.name,
      sizeBytes: file.size,
    });
  }
}
// If text is empty but we have attachments, use a placeholder
const text = event.text || (attachments.length > 0 ? '(file attachment)' : '');
```

- [ ] **Step 4: Write tests**

Test that a mocked `file_share` event with `files[]` produces the correct `InboundMessage.attachments`.

- [ ] **Step 5: Run tests + typecheck**

- [ ] **Step 6: Commit**

```
git add extensions/platform-slack/
git commit -m "feat(slack): allow file_share through triage, extract and cache file attachments"
```

---

## Task 7: Tool migration — `vision_analyze` and `read_file` declare `capabilities.attachments`

**Files:**
- Modify: `extensions/tools-vision/src/index.ts`
- Modify: `extensions/tools-file/src/index.ts` (the `read_file` tool)
- Test: update existing tool tests

- [ ] **Step 1: Add `ref` argument + capabilities to `vision_analyze`**

In the tool definition, add to `capabilities`:
```ts
capabilities: {
  // ...existing capabilities...
  attachments: { kinds: ['image'] },
},
```

Add `ref` to the schema:
```ts
ref: { type: 'string', description: 'Opaque attachment reference (e.g. att-0) from the <attachments> block' },
```

In `execute()`, when `ref` is provided:
```ts
if (args.ref && ctx.attachments) {
  const { path } = await ctx.attachments.openByRef(args.ref);
  // Read file from path and route to vision model
}
```

- [ ] **Step 2: Add `ref` argument + capabilities to `read_file`**

```ts
capabilities: {
  // ...existing capabilities...
  attachments: { kinds: ['file', 'image'] },
},
```

Add `ref` to schema. In `execute()`, when `ref` is set, resolve via `ctx.attachments.openByRef(ref)`.

- [ ] **Step 3: Run tests + typecheck**

- [ ] **Step 4: Commit**

```
git add extensions/tools-vision/ extensions/tools-file/
git commit -m "feat(tools): vision_analyze and read_file declare attachments capability, accept ref argument"
```

---

## Task 8: Cache lifecycle — `/new` cleanup, lane eviction, TTL sweep

**Files:**
- Modify: `extensions/gateway/src/index.ts` (cleanup on `/new` and eviction)
- Modify: `apps/ethos/src/wiring.ts` or `packages/wiring/src/index.ts` (TTL sweep scheduling)

- [ ] **Step 1: Hook `/new` in gateway**

Find where the gateway processes the `/new` slash command. Before forking the new session key, call `cache.clear(oldSessionKey)`.

- [ ] **Step 2: Hook lane eviction**

Find the LRU lane eviction logic. Add `cache.clear(sessionKey)` on evict.

- [ ] **Step 3: TTL sweep in wiring**

In the wiring layer, after constructing the `FsAttachmentCache`, schedule:
```ts
setInterval(() => {
  cache.pruneOlderThan(config.attachmentCacheTtlMs ?? 24 * 60 * 60 * 1000);
}, 60 * 60 * 1000);
```

- [ ] **Step 4: Run tests + typecheck**

- [ ] **Step 5: Commit**

```
git add extensions/gateway/ apps/ethos/ packages/wiring/
git commit -m "feat(gateway): attachment cache cleanup on /new, lane eviction, and hourly TTL sweep"
```

---

## Task 9: CLI `/attach` command + wiring

**Files:**
- Modify: `apps/ethos/src/commands/chat.ts`
- Modify: `apps/ethos/src/wiring.ts` (construct FsAttachmentCache)

- [ ] **Step 1: Construct `FsAttachmentCache` in wiring**

In the wiring layer, construct `FsAttachmentCache` with root at `~/.ethos/cache/attachments/` and pass it through to adapters and AgentLoop config.

- [ ] **Step 2: Add `/attach <path>` slash command**

In the chat REPL, handle `/attach <path>`:
- Resolve the path to absolute
- Read file bytes
- Write to cache via `cache.write(bytes, { sessionKey, messageId: Date.now().toString(), filename, mime })`
- Store the resulting `Attachment` to be included in the next `loop.run()` call

- [ ] **Step 3: Run typecheck**

- [ ] **Step 4: Commit**

```
git add apps/ethos/
git commit -m "feat(cli): add /attach <path> slash command for CLI attachment parity"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full test suite**

```
node_modules/.bin/vitest run
```
Expected: all pass

- [ ] **Step 2: Run typecheck**

```
npx tsc --noEmit -p tsconfig.json
```
Expected: clean

- [ ] **Step 3: Run lint**

```
node_modules/.bin/biome check .
```
Fix any issues.

- [ ] **Step 4: Final commit if needed**

```
git add -A
git commit -m "chore: lint fixes"
```
