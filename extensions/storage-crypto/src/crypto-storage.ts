import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type {
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';
import argon2 from 'argon2';
import { StorageDecryptionError } from './errors';

/**
 * Wire formats (SEC-002).
 *
 * v1 (written): [ magic "ETHC" (4) ][ version 0x01 (1) ][ salt (16) ][ IV (12) ][ tag (16) ][ ciphertext ]
 *   The salt is `randomBytes(16)`, chosen when a file is first written, so the
 *   Argon2id key is a function of (passphrase, random salt) — never of the path.
 *   The 21 header bytes are bound as GCM additional authenticated data, so a
 *   flipped version or salt byte fails the tag check like any other tamper.
 *   Nothing binds the key to the path, so `rename` keeps a file readable.
 *
 * v0 (read only): [ IV (12) ][ tag (16) ][ ciphertext ], key salted with
 *   sha256(path)[0..16]. Still decrypted so files written before v1 stay
 *   readable; the next write through this class re-writes them as v1.
 */
const MAGIC = Buffer.from('ETHC', 'ascii');
const VERSION_1 = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const V1_HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH;
const V0_HEADER_LENGTH = IV_LENGTH + TAG_LENGTH;

/** v0 only: the deterministic 16-byte salt the pre-v1 format derived from a path. */
function legacyPathSalt(path: string): Buffer {
  return createHash('sha256').update(path).digest().subarray(0, 16);
}

/** Derive an AES-256 key from a passphrase + salt using Argon2id. */
async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return argon2.hash(passphrase, {
    salt,
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 1,
    hashLength: 32,
    raw: true,
  });
}

/** Encrypt plaintext bytes with AES-256-GCM into the v1 wire format. */
function encryptV1(plaintext: Buffer, key: Buffer, salt: Buffer): Buffer {
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION_1]), salt]);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, iv, tag, encrypted]);
}

/** AES-256-GCM open of `[ IV ][ tag ][ ciphertext ]`. Throws StorageDecryptionError on failure. */
function open(body: Buffer, key: Buffer, path: string, aad?: Buffer): Buffer {
  if (body.byteLength < V0_HEADER_LENGTH) {
    throw new StorageDecryptionError(path, 'data too short (corrupted or not encrypted)');
  }
  const iv = body.subarray(0, IV_LENGTH);
  const tag = body.subarray(IV_LENGTH, V0_HEADER_LENGTH);
  const ciphertext = body.subarray(V0_HEADER_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new StorageDecryptionError(path, 'authentication failed (wrong key or corrupted data)');
  }
}

/** True when `buf` starts with the v1 magic. */
function hasMagic(buf: Buffer): boolean {
  return buf.byteLength >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Split a buffer that starts with the magic into its v1 header, salt and body. */
function parseV1(buf: Buffer, path: string): { header: Buffer; salt: Buffer; body: Buffer } {
  if (buf.byteLength < V1_HEADER_LENGTH) {
    throw new StorageDecryptionError(path, 'data too short (corrupted or not encrypted)');
  }
  const version = buf[MAGIC.length];
  if (version !== VERSION_1) {
    throw new StorageDecryptionError(path, `unsupported format version ${version}`);
  }
  return {
    header: buf.subarray(0, V1_HEADER_LENGTH),
    salt: buf.subarray(MAGIC.length + 1, V1_HEADER_LENGTH),
    body: buf.subarray(V1_HEADER_LENGTH),
  };
}

export class CryptoStorage implements Storage {
  /** Derived keys, keyed by the hex of the salt they were derived from. */
  private readonly keyCache = new Map<string, Buffer>();
  /** The v1 salt last read or written at each path, so re-writing a file this
   *  instance has already seen costs no fresh Argon2id derivation. A file is
   *  self-describing, so a stale entry only means a new file keeps an old salt
   *  — still random, still carried in its own header. */
  private readonly saltByPath = new Map<string, Buffer>();

  /**
   * @param inner  The underlying storage backend.
   * @param passphrase  Used only for Argon2id key derivation (stored for lazy per-salt derivation).
   */
  constructor(
    private readonly inner: Storage,
    private readonly passphrase: string,
  ) {}

  /** Get or derive the AES-256 key for a salt. */
  private async keyFor(salt: Buffer): Promise<Buffer> {
    const id = salt.toString('hex');
    const cached = this.keyCache.get(id);
    if (cached) return cached;
    const key = await deriveKey(this.passphrase, salt);
    this.keyCache.set(id, key);
    return key;
  }

  private async decrypt(data: Uint8Array, path: string): Promise<Buffer> {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const readV0 = async () => open(buf, await this.keyFor(legacyPathSalt(path)), path);
    if (!hasMagic(buf)) return readV0();
    try {
      const v1 = parseV1(buf, path);
      const plaintext = open(v1.body, await this.keyFor(v1.salt), path, v1.header);
      this.saltByPath.set(path, Buffer.from(v1.salt));
      return plaintext;
    } catch (err) {
      // A v0 file whose random IV happens to begin with "ETHC" (2^-32) is still
      // a v0 file; when it is not one either, the v1 failure is the answer.
      try {
        return await readV0();
      } catch {
        throw err;
      }
    }
  }

  private async encrypt(path: string, content: string | Uint8Array): Promise<Buffer> {
    const plaintext =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    let salt = this.saltByPath.get(path);
    if (!salt) {
      salt = randomBytes(SALT_LENGTH);
      this.saltByPath.set(path, salt);
    }
    return encryptV1(plaintext, await this.keyFor(salt), salt);
  }

  // --- Content-intercepting methods (encrypt/decrypt) --------------------

  async read(path: string): Promise<string | null> {
    const raw = await this.inner.readBytes(path);
    if (raw === null) return null;
    return (await this.decrypt(raw, path)).toString('utf-8');
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const raw = await this.inner.readBytes(path);
    if (raw === null) return null;
    return this.decrypt(raw, path);
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    return this.inner.write(path, await this.encrypt(path, content), opts);
  }

  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    return this.inner.writeAtomic(path, await this.encrypt(path, content), opts);
  }

  async append(path: string, content: string): Promise<void> {
    const raw = await this.inner.readBytes(path);
    const existing = raw === null ? '' : (await this.decrypt(raw, path)).toString('utf-8');
    return this.inner.write(path, await this.encrypt(path, existing + content));
  }

  // --- Pass-through methods (no content, just metadata/structure) --------

  async exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  async mtime(path: string): Promise<number | null> {
    return this.inner.mtime(path);
  }

  async list(dir: string): Promise<string[]> {
    return this.inner.list(dir);
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    return this.inner.listEntries(dir);
  }

  async mkdir(dir: string): Promise<void> {
    return this.inner.mkdir(dir);
  }

  async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    return this.inner.remove(path, opts);
  }

  /** A pass-through: the salt travels in the file's own header, so the bytes
   *  decrypt at `to` exactly as they did at `from`. */
  async rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(path, mode);
  }
}

export function createCryptoStorage(inner: Storage, passphrase: string): CryptoStorage {
  return new CryptoStorage(inner, passphrase);
}
