import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  SecretRef,
  SecretsResolver,
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';

/**
 * S3-backed implementation of the `Storage` contract.
 *
 * Path -> key mapping (deterministic and reversible):
 *   - S3 keys never have a leading '/'. We strip a leading '/' from the
 *     absolute path we are handed.
 *   - If a `prefix` is configured it is prepended, joined with '/'.
 *   So with prefix 'ethos':  '/config.yaml'      -> 'ethos/config.yaml'
 *      with no prefix:       '/team/a/notes.md'  -> 'team/a/notes.md'
 *   `list()` strips the request prefix back off to recover child basenames,
 *   which is the reverse of the same construction.
 *
 * Object-store semantics differ from a POSIX filesystem in three places the
 * `Storage` contract has to reconcile:
 *   - `mkdir` / `chmod` are no-ops — S3 has no directories and no POSIX modes.
 *   - `writeAtomic` == `write` — a single S3 PutObject is already all-or-nothing;
 *     a partially written object is never visible to a reader.
 *   - `append` is a read-modify-write (O(n)), because S3 objects are immutable.
 */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Normalized: no leading or trailing '/'. Empty string means "no prefix". */
  private readonly prefix: string;

  constructor(opts: { client: S3Client; bucket: string; prefix?: string }) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
  }

  /** Map an absolute path to an S3 key. Inverse of the prefix-strip in `list`. */
  private toKey(path: string): string {
    const rel = path.replace(/^\/+/, '');
    if (this.prefix === '') return rel;
    return rel === '' ? this.prefix : `${this.prefix}/${rel}`;
  }

  /** The S3 Prefix used to list the immediate children of a directory path. */
  private dirPrefix(dir: string): string {
    const key = this.toKey(dir);
    if (key === '') return '';
    return key.endsWith('/') ? key : `${key}/`;
  }

  async read(path: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
      );
      if (!res.Body) return '';
      return await res.Body.transformToString('utf-8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
      );
      if (!res.Body) return new Uint8Array(0);
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async mtime(path: string): Promise<number | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
      );
      return res.LastModified ? res.LastModified.getTime() : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dir: string): Promise<string[]> {
    return (await this.listEntries(dir)).map((e) => e.name);
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const listPrefix = this.dirPrefix(dir);
    // name -> isDir. A name can surface both as a placeholder object and a
    // CommonPrefix; treat it as a directory when either is true.
    const entries = new Map<string, boolean>();
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix,
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        const key = obj.Key;
        if (!key || key === listPrefix) continue; // skip the directory placeholder
        const name = key.slice(listPrefix.length);
        if (name === '') continue;
        if (!entries.has(name)) entries.set(name, false);
      }
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        const name = cp.Prefix.slice(listPrefix.length).replace(/\/$/, '');
        if (name === '') continue;
        entries.set(name, true);
      }
      // No silent truncation: follow the continuation token to completion.
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return [...entries.entries()]
      .map(([name, isDir]) => ({ name, isDir }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async write(
    path: string,
    content: string | Uint8Array,
    _opts?: StorageWriteOptions,
  ): Promise<void> {
    // `mode` is a POSIX concept with no S3 analog — accepted for contract
    // compatibility, intentionally ignored.
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.toKey(path), Body: body }),
    );
  }

  async append(path: string, content: string): Promise<void> {
    // S3 objects are immutable, so append is a read-modify-write (O(n)),
    // unlike FsStorage's O(1) appendFile. Missing object is treated as empty.
    const existing = await this.read(path);
    await this.write(path, (existing ?? '') + content);
  }

  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    // A single S3 PutObject is atomic: readers see either the old object or the
    // fully written new one, never a partial write. So the temp-file+rename
    // dance FsStorage needs is unnecessary here — write() already satisfies the
    // no-partial-corruption guarantee.
    await this.write(path, content, opts);
  }

  async mkdir(_dir: string): Promise<void> {
    // No-op: S3 has no directories. Keys carry their full path; parent
    // "directories" are implied by key prefixes and need no creation.
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    const key = this.toKey(path);
    if (opts?.recursive === true) {
      // Delete the object itself plus everything nested under "<key>/".
      const children = await this.collectAllKeys(`${key}/`);
      await this.deleteKeys([key, ...children]);
      return;
    }
    // Deleting a missing key is not an error in S3 (DeleteObject is idempotent).
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async rename(from: string, to: string): Promise<void> {
    const fromKey = this.toKey(from);
    const toKey = this.toKey(to);
    // Gather the source object (if it exists) plus any nested children so a
    // "directory" rename moves the whole subtree.
    const sources: string[] = [];
    if (await this.exists(from)) sources.push(fromKey);
    for (const child of await this.collectAllKeys(`${fromKey}/`)) sources.push(child);
    if (sources.length === 0) {
      const err = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    for (const src of sources) {
      const dst = src === fromKey ? toKey : `${toKey}${src.slice(fromKey.length)}`;
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          CopySource: encodeURI(`${this.bucket}/${src}`),
          Key: dst,
        }),
      );
    }
    await this.deleteKeys(sources);
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // No-op: S3 has no POSIX permission concept.
  }

  /** List every key under `prefix`, following pagination to completion. */
  private async collectAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  /** Delete keys in batches of 1000 (the DeleteObjects API limit). */
  private async deleteKeys(keys: string[]): Promise<void> {
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }
}

/** Config shape read from `config.storage.s3`. */
interface S3StorageConfig {
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Optional secret refs for static credentials (resolved via SecretsResolver). */
  accessKeyId?: SecretRef;
  secretAccessKey?: SecretRef;
}

/**
 * Build an `S3Storage` from config. `config` is the `storage` block; S3 settings
 * live under `config.s3`. Credentials: if both `accessKeyId` and
 * `secretAccessKey` are configured they are treated as secret refs and resolved
 * via `secrets`; otherwise the SDK's default credential chain is used (env vars
 * / EC2 instance profile / ECS task role).
 */
export async function createS3Storage(
  config: Record<string, unknown>,
  secrets: SecretsResolver,
): Promise<S3Storage> {
  const s3 = (config.s3 ?? {}) as S3StorageConfig;
  const bucket = s3.bucket;
  if (!bucket) {
    throw new Error(
      'storage.backend is "s3" but storage.s3.bucket is not set. Add storage.s3.bucket to config.yaml.',
    );
  }
  const credentials = await resolveCredentials(s3, secrets);
  const client = new S3Client({
    ...(s3.region ? { region: s3.region } : {}),
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    ...(s3.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(credentials ? { credentials } : {}),
  });
  return new S3Storage({ client, bucket, prefix: s3.prefix });
}

async function resolveCredentials(
  s3: S3StorageConfig,
  secrets: SecretsResolver,
): Promise<{ accessKeyId: string; secretAccessKey: string } | undefined> {
  if (!s3.accessKeyId || !s3.secretAccessKey) return undefined;
  const [accessKeyId, secretAccessKey] = await Promise.all([
    secrets.get(s3.accessKeyId),
    secrets.get(s3.secretAccessKey),
  ]);
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey };
}

/** S3 / Head 404 signals across SDK error shapes: NoSuchKey, NotFound, 404. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
