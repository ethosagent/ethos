// Input resolver — security-critical edge between user input (path / URL /
// base64) and the bytes we hand to a vision-capable LLM. Tests cover:
//   - happy paths for each input shape (PNG, PDF)
//   - magic-byte detection (correct media type, rejection of unknowns)
//   - media-aware size limits (5 MB images, 32 MB PDFs)
//   - SSRF / boundary error translation
//   - invalid input shapes (0 keys, >=2 keys)

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError, type Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFile, VisionInputError } from '../input-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Smallest valid PNG (1x1 transparent) — Wikipedia "Portable Network Graphics".
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

// Smallest valid JPEG header (just the SOI + APP0 marker) — enough for magic
// detection, but the byte stream is intentionally short so size-limit code is
// exercised separately with synthetic oversized buffers.
const TINY_JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');

const TINY_GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');

// 'RIFF' <4 bytes size> 'WEBP'
const TINY_WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(18, 0),
]);

// Minimal PDF — `%PDF-` is all the magic check needs; pad with `%%EOF`.
const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

// 5 MB + 1 byte of zeros, prefixed with PNG magic. Triggers the per-media
// image size cap (5 MB).
const OVERSIZED_PNG = Buffer.concat([
  TINY_PNG.subarray(0, 8),
  Buffer.alloc(5 * 1024 * 1024 - 7, 0),
]);

// 32 MB + 1 byte, prefixed with `%PDF-`. Triggers the per-media PDF cap.
const OVERSIZED_PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'utf8'),
  Buffer.alloc(32 * 1024 * 1024, 0),
]);

// Random bytes that match none of the known magic prefixes.
const UNKNOWN_BYTES = Buffer.from('not-an-image-or-pdf-just-text', 'utf8');

// ---------------------------------------------------------------------------
// Helpers — fake storage with controllable read paths
// ---------------------------------------------------------------------------

class FakeStorage implements Storage {
  constructor(private readonly files: Map<string, Buffer>) {}

  async read(path: string): Promise<string | null> {
    // file_path mode reads binary via node:fs after a Storage boundary check.
    // The resolver calls `exists` (which triggers BoundaryError if blocked);
    // `read` is here only to satisfy the interface.
    const buf = this.files.get(path);
    return buf ? buf.toString('utf8') : null;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async mtime(): Promise<number | null> {
    return null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  async listEntries() {
    return [];
  }
  async write(): Promise<void> {}
  async append(): Promise<void> {}
  async writeAtomic(): Promise<void> {}
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
}

class BoundaryStorage implements Storage {
  async read(path: string): Promise<string | null> {
    throw new BoundaryError('read', path, ['/safe/']);
  }
  async exists(path: string): Promise<boolean> {
    throw new BoundaryError('read', path, ['/safe/']);
  }
  async mtime(): Promise<number | null> {
    return null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  async listEntries() {
    return [];
  }
  async write(): Promise<void> {}
  async append(): Promise<void> {}
  async writeAtomic(): Promise<void> {}
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// File-system fixtures — real files in os.tmpdir() for the file_path branch
// because the resolver does a controlled binary read via node:fs after
// validating the path against ScopedStorage. The fake storage above only
// records WHICH paths are allowed.
// ---------------------------------------------------------------------------

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vision-resolve-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveFile — input shape validation', () => {
  it('rejects when no input key is set', async () => {
    await expect(resolveFile({}, {})).rejects.toMatchObject({
      name: 'VisionInputError',
      code: 'INVALID_INPUT',
    });
  });

  it('rejects when two input keys are set', async () => {
    await expect(resolveFile({ file_path: '/x', file_url: 'https://x' }, {})).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    );
  });

  it('rejects when all three input keys are set', async () => {
    await expect(
      resolveFile({ file_path: '/x', file_url: 'https://x', file_base64: 'aGk=' }, {}),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('resolveFile — file_base64 branch', () => {
  it('decodes a plain base64 PNG and detects image/png', async () => {
    const b64 = TINY_PNG.toString('base64');
    const out = await resolveFile({ file_base64: b64 }, {});
    expect(out.mediaType).toBe('image/png');
    expect(out.buffer.equals(TINY_PNG)).toBe(true);
  });

  it('strips a data: URI prefix before decoding', async () => {
    const b64 = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
    const out = await resolveFile({ file_base64: b64 }, {});
    expect(out.mediaType).toBe('image/png');
    expect(out.buffer.equals(TINY_PNG)).toBe(true);
  });

  it('decodes JPEG / GIF / WEBP / PDF magic correctly', async () => {
    const jpeg = await resolveFile({ file_base64: TINY_JPEG.toString('base64') }, {});
    expect(jpeg.mediaType).toBe('image/jpeg');

    const gif = await resolveFile({ file_base64: TINY_GIF.toString('base64') }, {});
    expect(gif.mediaType).toBe('image/gif');

    const webp = await resolveFile({ file_base64: TINY_WEBP.toString('base64') }, {});
    expect(webp.mediaType).toBe('image/webp');

    const pdf = await resolveFile({ file_base64: TINY_PDF.toString('base64') }, {});
    expect(pdf.mediaType).toBe('application/pdf');
  });

  it('rejects empty base64', async () => {
    await expect(resolveFile({ file_base64: '' }, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects bytes with no known magic prefix', async () => {
    const b64 = UNKNOWN_BYTES.toString('base64');
    await expect(resolveFile({ file_base64: b64 }, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });

  it('rejects an oversized image (>5 MB) as FILE_TOO_LARGE', async () => {
    const b64 = OVERSIZED_PNG.toString('base64');
    await expect(resolveFile({ file_base64: b64 }, {})).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });

  it('rejects an oversized PDF (>32 MB) as FILE_TOO_LARGE', async () => {
    const b64 = OVERSIZED_PDF.toString('base64');
    await expect(resolveFile({ file_base64: b64 }, {})).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });
});

describe('resolveFile — file_path branch', () => {
  it('requires ctx.storage', async () => {
    await expect(resolveFile({ file_path: '/some/file.png' }, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('reads a PNG file and returns the buffer + media type', async () => {
    const path = join(tmpDir, 'image.png');
    writeFileSync(path, TINY_PNG);
    const storage = new FakeStorage(new Map([[path, TINY_PNG]]));
    const out = await resolveFile({ file_path: path }, { storage });
    expect(out.mediaType).toBe('image/png');
    expect(out.buffer.equals(TINY_PNG)).toBe(true);
  });

  it('resolves relative paths against ctx.workingDir', async () => {
    const path = join(tmpDir, 'image.png');
    writeFileSync(path, TINY_PNG);
    const storage = new FakeStorage(new Map([[path, TINY_PNG]]));
    const out = await resolveFile({ file_path: 'image.png' }, { storage, workingDir: tmpDir });
    expect(out.mediaType).toBe('image/png');
  });

  it('translates ScopedStorage BoundaryError to FILE_NOT_FOUND', async () => {
    const storage = new BoundaryStorage();
    await expect(resolveFile({ file_path: '/etc/passwd' }, { storage })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('returns FILE_NOT_FOUND when the file is absent', async () => {
    const storage = new FakeStorage(new Map());
    await expect(
      resolveFile({ file_path: join(tmpDir, 'missing.png') }, { storage }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects oversized PDFs read from disk', async () => {
    const path = join(tmpDir, 'big.pdf');
    writeFileSync(path, OVERSIZED_PDF);
    const storage = new FakeStorage(new Map([[path, OVERSIZED_PDF]]));
    await expect(resolveFile({ file_path: path }, { storage })).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  });

  it('rejects an unknown file type', async () => {
    const path = join(tmpDir, 'mystery.bin');
    writeFileSync(path, UNKNOWN_BYTES);
    const storage = new FakeStorage(new Map([[path, UNKNOWN_BYTES]]));
    await expect(resolveFile({ file_path: path }, { storage })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });
});

// ---------------------------------------------------------------------------
// Path-traversal — wired against real ScopedStorage to prove that the
// resolver collapses `..`/`.` segments AND canonicalizes symlinks before the
// allowlist check fires. Without these, ScopedStorage's lexical prefix match
// (packages/storage-fs/src/scoped-storage.ts:isPathAllowed) would accept
// `/safe/../etc/passwd` and `/safe/innocent.png → /etc/passwd`, then
// fs.readFile would resolve those to paths outside the allowlist.
// ---------------------------------------------------------------------------

describe('resolveFile — file_path branch / path-traversal defenses', () => {
  let safeDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    // Canonicalize through realpath — on macOS tmpdir() lives under
    // /var/folders/... which is a symlink to /private/var/folders/...; the
    // resolver canonicalizes the request path, so the allowlist prefix must
    // already be canonical or the prefix check sees a /private/var path
    // against a /var prefix.
    safeDir = await realpath(mkdtempSync(join(tmpdir(), 'vision-safe-')));
    outsideDir = await realpath(mkdtempSync(join(tmpdir(), 'vision-outside-')));
  });

  afterEach(() => {
    rmSync(safeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  function scopedFor(prefix: string): ScopedStorage {
    return new ScopedStorage(new FsStorage(), {
      read: [`${prefix}/`],
      write: [`${prefix}/`],
    });
  }

  it('rejects an absolute path whose lexical prefix is allowed but normalizes outside the allowlist', async () => {
    // Place a real target outside the allowlist that fs.readFile WOULD reach
    // after `..` normalization — proves the resolver normalizes BEFORE the
    // boundary check, not just after.
    writeFileSync(join(outsideDir, 'secret.png'), TINY_PNG);
    const escapePath = `${safeDir}/../${outsideDir.split('/').pop()}/secret.png`;
    const storage = scopedFor(safeDir);

    await expect(
      resolveFile({ file_path: escapePath }, { storage, workingDir: safeDir }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects a relative path with `..` that escapes the workingDir outside the allowlist', async () => {
    writeFileSync(join(outsideDir, 'secret.png'), TINY_PNG);
    const relativeEscape = `../${outsideDir.split('/').pop()}/secret.png`;
    const storage = scopedFor(safeDir);

    await expect(
      resolveFile({ file_path: relativeEscape }, { storage, workingDir: safeDir }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects a symlink inside the allowlist that points to a file outside it', async () => {
    const realTarget = join(outsideDir, 'secret.png');
    writeFileSync(realTarget, TINY_PNG);
    const linkInsideSafe = join(safeDir, 'innocent.png');
    symlinkSync(realTarget, linkInsideSafe);
    const storage = scopedFor(safeDir);

    await expect(
      resolveFile({ file_path: linkInsideSafe }, { storage, workingDir: safeDir }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});

describe('resolveFile — file_url branch', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(resolveFile({ file_url: 'file:///etc/passwd' }, {})).rejects.toMatchObject({
      code: 'URL_BLOCKED',
    });
    await expect(resolveFile({ file_url: 'ftp://example.com/x.png' }, {})).rejects.toMatchObject({
      code: 'URL_BLOCKED',
    });
  });

  it('translates safe-fetch failures (SSRF block / cloud-metadata) to URL_BLOCKED', async () => {
    // Trigger the cloud-metadata block — non-overridable, no fetch needed.
    await expect(
      resolveFile({ file_url: 'http://169.254.169.254/latest/meta-data/' }, {}),
    ).rejects.toMatchObject({ code: 'URL_BLOCKED' });
  });

  it('downloads a PNG via injected fetch and detects the media type', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    const out = await resolveFile(
      { file_url: 'https://example.com/img.png' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: async () => ['8.8.8.8'] },
    );
    expect(out.mediaType).toBe('image/png');
    expect(out.buffer.equals(TINY_PNG)).toBe(true);
  });

  it('aborts the download once received bytes exceed the 32 MB ceiling', async () => {
    // Stream 33 MB so the per-chunk byte counter trips the cap.
    const chunkSize = 1024 * 1024;
    const chunks = Array.from({ length: 33 }, () => Buffer.alloc(chunkSize, 0));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => {
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/pdf' } });
    });
    await expect(
      resolveFile(
        { file_url: 'https://example.com/big.pdf' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: async () => ['8.8.8.8'] },
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('applies the per-media image cap after download', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(OVERSIZED_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    await expect(
      resolveFile(
        { file_url: 'https://example.com/big.png' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: async () => ['8.8.8.8'] },
      ),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('returns UNSUPPORTED_FILE_TYPE when fetched bytes do not match any magic', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(UNKNOWN_BYTES, { status: 200 });
    });
    await expect(
      resolveFile(
        { file_url: 'https://example.com/x' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: async () => ['8.8.8.8'] },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });
});

describe('VisionInputError', () => {
  it('carries the typed code and a message', () => {
    const err = new VisionInputError('UNSUPPORTED_FILE_TYPE', 'nope');
    expect(err.name).toBe('VisionInputError');
    expect(err.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(err.message).toBe('nope');
  });
});
