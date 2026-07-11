import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ScopedStorage } from '@ethosagent/storage-fs';
import { BoundaryError } from '@ethosagent/types';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { S3Storage } from '../index';

// -----------------------------------------------------------------------------
// In-memory S3 fake: a Map<key, {body, lastModified}> wired behind the SDK mock.
// Covers Get / Head / Put / Delete / DeleteObjects / Copy / ListObjectsV2, plus
// NoSuchKey / NotFound (404) behavior. The non-delimiter ListObjectsV2 branch
// pages at size 2 so the continuation-token loop is actually exercised.
// -----------------------------------------------------------------------------

interface FakeEntry {
  body: Buffer;
  lastModified: Date;
}

const store = new Map<string, FakeEntry>();
const s3Mock = mockClient(S3Client);

function notFound(name: string): Error {
  const err = new Error(name);
  err.name = name;
  (err as { $metadata?: { httpStatusCode?: number } }).$metadata = { httpStatusCode: 404 };
  return err;
}

function toBuffer(body: unknown): Buffer {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body));
}

function streamBody(buf: Buffer): GetObjectCommandOutput['Body'] {
  return {
    transformToString: async (encoding?: string) =>
      buf.toString((encoding as BufferEncoding) ?? 'utf-8'),
    transformToByteArray: async () => new Uint8Array(buf),
  } as unknown as GetObjectCommandOutput['Body'];
}

function wireMock(): void {
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const entry = store.get(input.Key);
    if (!entry) throw notFound('NoSuchKey');
    return {
      Body: streamBody(entry.body),
      LastModified: entry.lastModified,
      ContentLength: entry.body.length,
    } as GetObjectCommandOutput;
  });

  s3Mock.on(HeadObjectCommand).callsFake((input) => {
    const entry = store.get(input.Key);
    if (!entry) throw notFound('NotFound');
    return {
      LastModified: entry.lastModified,
      ContentLength: entry.body.length,
    } as HeadObjectCommandOutput;
  });

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.Key) store.set(input.Key, { body: toBuffer(input.Body), lastModified: new Date() });
    return {};
  });

  s3Mock.on(DeleteObjectCommand).callsFake((input) => {
    if (input.Key) store.delete(input.Key);
    return {};
  });

  s3Mock.on(DeleteObjectsCommand).callsFake((input) => {
    const objects = input.Delete?.Objects ?? [];
    for (const obj of objects) if (obj.Key) store.delete(obj.Key);
    return { Deleted: objects };
  });

  s3Mock.on(CopyObjectCommand).callsFake((input) => {
    const source = decodeURI(String(input.CopySource)).replace(/^\//, '');
    const srcKey = source.slice(source.indexOf('/') + 1);
    const entry = store.get(srcKey);
    if (!entry) throw notFound('NoSuchKey');
    if (input.Key)
      store.set(input.Key, { body: Buffer.from(entry.body), lastModified: new Date() });
    return {};
  });

  s3Mock.on(ListObjectsV2Command).callsFake((input) => {
    const prefix = input.Prefix ?? '';
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (input.Delimiter) {
      const delimiter = input.Delimiter;
      const files: string[] = [];
      const common = new Set<string>();
      for (const key of all) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx === -1) files.push(key);
        else common.add(prefix + rest.slice(0, idx + delimiter.length));
      }
      return {
        Contents: files.map((Key) => ({ Key })),
        CommonPrefixes: [...common].sort().map((Prefix) => ({ Prefix })),
        IsTruncated: false,
      } as ListObjectsV2CommandOutput;
    }
    // Non-delimiter: page at size 2 so pagination is exercised end-to-end.
    const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
    const page = all.slice(start, start + 2);
    const nextStart = start + page.length;
    const truncated = nextStart < all.length;
    return {
      Contents: page.map((Key) => ({ Key })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? String(nextStart) : undefined,
    } as ListObjectsV2CommandOutput;
  });
}

beforeEach(() => {
  store.clear();
  s3Mock.reset();
  wireMock();
});

function make(prefix?: string): S3Storage {
  return new S3Storage({
    client: s3Mock as unknown as S3Client,
    bucket: 'test-bucket',
    prefix,
  });
}

// -----------------------------------------------------------------------------
// Storage contract conformance. Replicated inline rather than importing
// runStorageConformance from @ethosagent/storage-fs: that module executes
// `runStorageConformance('InMemoryStorage', ...)` at import time, which would
// re-run the InMemoryStorage suite inside this S3 test file as a side effect.
// -----------------------------------------------------------------------------

describe('Storage conformance: S3Storage', () => {
  it('writeAtomic is all-or-nothing: content matches on read-back', async () => {
    const storage = make();
    await storage.mkdir('/test');
    await storage.writeAtomic('/test/atomic.txt', 'hello world');
    expect(await storage.read('/test/atomic.txt')).toBe('hello world');
  });

  it('read returns null on missing file', async () => {
    expect(await make().read('/nonexistent')).toBeNull();
  });

  it('exists returns false on missing file', async () => {
    expect(await make().exists('/nonexistent')).toBe(false);
  });

  it('mtime returns null on missing file', async () => {
    expect(await make().mtime('/nonexistent')).toBeNull();
  });

  it('chmod does not throw (no-op for non-POSIX)', async () => {
    const storage = make();
    await storage.mkdir('/test');
    await storage.write('/test/file.txt', 'data');
    await expect(storage.chmod('/test/file.txt', 0o600)).resolves.not.toThrow();
  });

  it('BoundaryError passthrough when wrapped in ScopedStorage', async () => {
    const scoped = new ScopedStorage(make(), { read: ['/allowed'], write: ['/allowed'] });
    await expect(scoped.read('/forbidden/file.txt')).rejects.toThrow(BoundaryError);
  });
});

// -----------------------------------------------------------------------------
// S3-specific behavior.
// -----------------------------------------------------------------------------

describe('S3Storage: object-store semantics', () => {
  it('read returns null on NoSuchKey', async () => {
    expect(await make().read('/missing.txt')).toBeNull();
    expect(await make().readBytes('/missing.txt')).toBeNull();
  });

  it('writeAtomic round-trips binary bytes via readBytes', async () => {
    const storage = make();
    const bytes = new Uint8Array([0xff, 0x00, 0xd8, 0xff]); // invalid utf-8
    await storage.writeAtomic('/blob.bin', bytes);
    expect(await storage.readBytes('/blob.bin')).toEqual(bytes);
  });

  it('mtime is derived from LastModified', async () => {
    const storage = make();
    await storage.write('/a.txt', 'x');
    const mtime = await storage.mtime('/a.txt');
    const stored = store.get('a.txt');
    expect(mtime).toBe(stored?.lastModified.getTime());
  });

  it('list returns immediate child basenames with prefix + delimiter', async () => {
    const storage = make();
    await storage.write('/dir/a.txt', '1');
    await storage.write('/dir/b.txt', '2');
    await storage.write('/dir/sub/c.txt', '3');
    await storage.write('/other.txt', '4');
    expect(await storage.list('/dir')).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('listEntries tags dirs (CommonPrefixes) vs files (Contents)', async () => {
    const storage = make();
    await storage.write('/dir/a.txt', '1');
    await storage.write('/dir/sub/c.txt', '3');
    expect(await storage.listEntries('/dir')).toEqual([
      { name: 'a.txt', isDir: false },
      { name: 'sub', isDir: true },
    ]);
  });

  it('list returns [] for a missing directory', async () => {
    expect(await make().list('/nope')).toEqual([]);
  });

  it('recursive remove deletes every key under the prefix', async () => {
    const storage = make();
    await storage.write('/dir/a.txt', '1');
    await storage.write('/dir/sub/b.txt', '2');
    await storage.write('/dir/sub/deep/c.txt', '3');
    await storage.write('/keep.txt', 'x');
    await storage.remove('/dir', { recursive: true });
    expect(await storage.exists('/dir/a.txt')).toBe(false);
    expect(await storage.exists('/dir/sub/b.txt')).toBe(false);
    expect(await storage.exists('/dir/sub/deep/c.txt')).toBe(false);
    expect(await storage.exists('/keep.txt')).toBe(true);
  });

  it('non-recursive remove of a missing key does not throw', async () => {
    await expect(make().remove('/ghost.txt')).resolves.not.toThrow();
  });

  it('append is a read-modify-write and creates a missing object', async () => {
    const storage = make();
    await storage.append('/log.txt', 'a');
    await storage.append('/log.txt', 'b');
    expect(await storage.read('/log.txt')).toBe('ab');
  });

  it('rename moves a whole subtree', async () => {
    const storage = make();
    await storage.write('/from/a.txt', '1');
    await storage.write('/from/sub/b.txt', '2');
    await storage.rename('/from', '/to');
    expect(await storage.exists('/from/a.txt')).toBe(false);
    expect(await storage.read('/to/a.txt')).toBe('1');
    expect(await storage.read('/to/sub/b.txt')).toBe('2');
  });

  it('path -> key prefix mapping round-trips through list', async () => {
    const storage = make('ethos/home');
    await storage.write('/config.yaml', 'k: v');
    // Stored under the configured prefix...
    expect(store.has('ethos/home/config.yaml')).toBe(true);
    // ...and list() strips the prefix back off to recover the basename.
    expect(await storage.list('/')).toEqual(['config.yaml']);
    expect(await storage.read('/config.yaml')).toBe('k: v');
  });
});

// -----------------------------------------------------------------------------
// Real-bucket integration. Skipped unless ETHOS_S3_TEST_BUCKET is set, so CI
// (which has no AWS credentials) skips it. This honestly defers the plan's
// "one real bucket" exit criterion to an environment that has credentials.
// -----------------------------------------------------------------------------

describe.skipIf(!process.env.ETHOS_S3_TEST_BUCKET)('S3Storage: real bucket', () => {
  it('writes and reads back against a live bucket', async () => {
    const bucket = process.env.ETHOS_S3_TEST_BUCKET as string;
    const client = new S3Client({
      ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
    });
    const storage = new S3Storage({ client, bucket, prefix: 'ethos-s3-test' });
    const key = `/it-${Date.now()}.txt`;
    await storage.writeAtomic(key, 'round-trip');
    expect(await storage.read(key)).toBe('round-trip');
    await storage.remove(key);
    expect(await storage.exists(key)).toBe(false);
    client.destroy();
  });
});

afterAll(() => {
  s3Mock.restore();
});
