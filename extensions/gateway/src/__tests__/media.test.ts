import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentsFromStructured,
  decodeDataUrl,
  isOutboundMediaSource,
  OUTBOUND_MEDIA_MAX_BYTES,
} from '../media';

const CAPS_ALL = { imagesOut: true, filesOut: true };
const CAPS_NONE = { imagesOut: false, filesOut: false };

describe('isOutboundMediaSource', () => {
  it('accepts the recognized shape (path or base64)', () => {
    expect(isOutboundMediaSource({ kind: 'image', path: '/a.png', mimeType: 'image/png' })).toBe(
      true,
    );
    expect(isOutboundMediaSource({ kind: 'file', base64: 'AAAA', mimeType: 'text/plain' })).toBe(
      true,
    );
  });

  it('rejects unrelated structured payloads', () => {
    expect(isOutboundMediaSource(undefined)).toBe(false);
    expect(isOutboundMediaSource({ foo: 'bar' })).toBe(false);
    expect(isOutboundMediaSource({ kind: 'image', mimeType: 'image/png' })).toBe(false); // no bytes
    expect(isOutboundMediaSource({ kind: 'image', path: '/a', mimeType: '' })).toBe(false);
  });
});

describe('attachmentsFromStructured', () => {
  it('maps a path-based image to a native attachment when caps allow', () => {
    const out = attachmentsFromStructured(
      { kind: 'image', path: '/tmp/chart.png', mimeType: 'image/png', filename: 'chart.png' },
      CAPS_ALL,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'image',
      url: '/tmp/chart.png',
      mimeType: 'image/png',
      filename: 'chart.png',
    });
  });

  it('maps a base64 file to a data: URL attachment with a size', () => {
    const b64 = Buffer.from('hello world').toString('base64');
    const out = attachmentsFromStructured(
      { kind: 'file', base64: b64, mimeType: 'text/plain', filename: 'note.txt' },
      CAPS_ALL,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.url.startsWith('data:text/plain;base64,')).toBe(true);
    expect(out[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('degrades to text-only ([]) when caps forbid the kind', () => {
    const out = attachmentsFromStructured(
      { kind: 'image', path: '/a.png', mimeType: 'image/png' },
      CAPS_NONE,
    );
    expect(out).toEqual([]);
  });

  it('respects imagesOut vs filesOut independently', () => {
    const caps = { imagesOut: true, filesOut: false };
    expect(
      attachmentsFromStructured({ kind: 'image', path: '/a.png', mimeType: 'image/png' }, caps),
    ).toHaveLength(1);
    expect(
      attachmentsFromStructured(
        { kind: 'file', path: '/a.bin', mimeType: 'application/octet-stream' },
        caps,
      ),
    ).toEqual([]);
  });

  it('respects the size cap for base64 payloads', () => {
    // A base64 string whose decoded length exceeds a tiny cap → dropped.
    const big = 'A'.repeat(4096); // decodes to ~3072 bytes
    const out = attachmentsFromStructured(
      { kind: 'file', base64: big, mimeType: 'application/octet-stream' },
      CAPS_ALL,
      1024, // 1 KiB cap
    );
    expect(out).toEqual([]);
  });

  it('returns [] for non-media structured payloads', () => {
    expect(attachmentsFromStructured({ rows: [1, 2, 3] }, CAPS_ALL)).toEqual([]);
    expect(attachmentsFromStructured(undefined, CAPS_ALL)).toEqual([]);
  });

  it('exposes a default cap that is a sane positive size', () => {
    expect(OUTBOUND_MEDIA_MAX_BYTES).toBeGreaterThan(0);
  });

  // Boundary tests at the REAL 20 MiB cap using exact-sized payloads. base64 of
  // Buffer.alloc(n) decodes to exactly n bytes, so the true decoded length —
  // not the padding-inflated upper bound — must decide the drop.
  describe('base64 size cap boundary (true decoded length)', () => {
    const b64OfSize = (n: number) => Buffer.alloc(n).toString('base64');

    it('accepts a payload exactly at the cap', () => {
      const out = attachmentsFromStructured(
        {
          kind: 'file',
          base64: b64OfSize(OUTBOUND_MEDIA_MAX_BYTES),
          mimeType: 'application/octet-stream',
        },
        CAPS_ALL,
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.sizeBytes).toBe(OUTBOUND_MEDIA_MAX_BYTES);
    });

    it('accepts a payload just under the cap', () => {
      const out = attachmentsFromStructured(
        {
          kind: 'file',
          base64: b64OfSize(OUTBOUND_MEDIA_MAX_BYTES - 1),
          mimeType: 'application/octet-stream',
        },
        CAPS_ALL,
      );
      expect(out).toHaveLength(1);
      expect(out[0]?.sizeBytes).toBe(OUTBOUND_MEDIA_MAX_BYTES - 1);
    });

    it('drops a payload just over the cap', () => {
      const out = attachmentsFromStructured(
        {
          kind: 'file',
          base64: b64OfSize(OUTBOUND_MEDIA_MAX_BYTES + 1),
          mimeType: 'application/octet-stream',
        },
        CAPS_ALL,
      );
      expect(out).toEqual([]);
    });
  });
});

describe('attachmentsFromStructured — path-safety guard (exfiltration)', () => {
  it('degrades to text-only for a parent-traversal path', () => {
    const out = attachmentsFromStructured(
      { kind: 'file', path: '/tmp/../etc/passwd', mimeType: 'text/plain' },
      CAPS_ALL,
    );
    expect(out).toEqual([]);
  });

  it('degrades to text-only for a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-media-'));
    const target = join(dir, 'secret.txt');
    writeFileSync(target, 'secret');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    const out = attachmentsFromStructured(
      { kind: 'file', path: link, mimeType: 'text/plain' },
      CAPS_ALL,
    );
    expect(out).toEqual([]);
  });

  it('invokes onReject with the rejected path', () => {
    const rejected: string[] = [];
    attachmentsFromStructured(
      { kind: 'file', path: '/tmp/../x', mimeType: 'text/plain' },
      CAPS_ALL,
      OUTBOUND_MEDIA_MAX_BYTES,
      (p) => rejected.push(p),
    );
    expect(rejected).toEqual(['/tmp/../x']);
  });

  it('allows a plain regular-file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-media-'));
    const f = join(dir, 'ok.png');
    writeFileSync(f, 'x');
    const out = attachmentsFromStructured(
      { kind: 'image', path: f, mimeType: 'image/png' },
      CAPS_ALL,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe(f);
  });
});

describe('decodeDataUrl', () => {
  it('decodes a data: URI to bytes + mime', () => {
    const b64 = Buffer.from('abc').toString('base64');
    const out = decodeDataUrl(`data:image/png;base64,${b64}`);
    expect(out?.mimeType).toBe('image/png');
    expect(Buffer.from(out?.bytes ?? new Uint8Array()).toString()).toBe('abc');
  });

  it('returns null for a plain path', () => {
    expect(decodeDataUrl('/tmp/x.png')).toBeNull();
  });
});
