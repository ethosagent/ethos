import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type {
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
} from '@ethosagent/types';
import argon2 from 'argon2';
import { StorageDecryptionError } from './errors';

/** Wire format: [ IV (12 bytes) ][ auth tag (16 bytes) ][ ciphertext ] */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = IV_LENGTH + TAG_LENGTH;

/** Derive a deterministic 16-byte salt from a file path via SHA-256. */
function pathSalt(path: string): Buffer {
  return createHash('sha256').update(path).digest().subarray(0, 16);
}

/** Derive an AES-256 key from a passphrase + path-based salt using Argon2id. */
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

/** Encrypt plaintext bytes with AES-256-GCM, returning the wire-format buffer. */
function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/** Decrypt wire-format bytes, returning plaintext. Throws StorageDecryptionError on failure. */
function decrypt(data: Uint8Array, key: Buffer, path: string): Buffer {
  if (data.byteLength < HEADER_LENGTH) {
    throw new StorageDecryptionError(path, 'data too short (corrupted or not encrypted)');
  }

  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, HEADER_LENGTH);
  const ciphertext = buf.subarray(HEADER_LENGTH);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new StorageDecryptionError(path, 'authentication failed (wrong key or corrupted data)');
  }
}

export class CryptoStorage implements Storage {
  /** Cached derived keys, keyed by normalized file path. */
  private readonly keyCache = new Map<string, Buffer>();

  /**
   * @param inner  The underlying storage backend.
   * @param passphrase  Used only for Argon2id key derivation (stored for lazy per-path derivation).
   */
  constructor(
    private readonly inner: Storage,
    private readonly passphrase: string,
  ) {}

  /** Get or derive the AES-256 key for a given path. */
  private async getKey(path: string): Promise<Buffer> {
    const cached = this.keyCache.get(path);
    if (cached) return cached;

    const salt = pathSalt(path);
    const key = await deriveKey(this.passphrase, salt);
    this.keyCache.set(path, key);
    return key;
  }

  // --- Content-intercepting methods (encrypt/decrypt) --------------------

  async read(path: string): Promise<string | null> {
    const raw = await this.inner.readBytes(path);
    if (raw === null) return null;

    const key = await this.getKey(path);
    const plaintext = decrypt(raw, key, path);
    return plaintext.toString('utf-8');
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const raw = await this.inner.readBytes(path);
    if (raw === null) return null;

    const key = await this.getKey(path);
    return decrypt(raw, key, path);
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    const plaintext =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    const key = await this.getKey(path);
    const encrypted = encrypt(plaintext, key);
    return this.inner.write(path, encrypted, opts);
  }

  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: StorageWriteOptions,
  ): Promise<void> {
    const plaintext =
      typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    const key = await this.getKey(path);
    const encrypted = encrypt(plaintext, key);
    return this.inner.writeAtomic(path, encrypted, opts);
  }

  async append(path: string, content: string): Promise<void> {
    const raw = await this.inner.readBytes(path);
    const key = await this.getKey(path);

    let existing: string;
    if (raw === null) {
      existing = '';
    } else {
      const plaintext = decrypt(raw, key, path);
      existing = plaintext.toString('utf-8');
    }

    const combined = Buffer.from(existing + content, 'utf-8');
    const encrypted = encrypt(combined, key);
    return this.inner.write(path, encrypted);
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
