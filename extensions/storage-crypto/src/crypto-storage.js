import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { StorageDecryptionError } from './errors';
/** Wire format: [ IV (12 bytes) ][ auth tag (16 bytes) ][ ciphertext ] */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = IV_LENGTH + TAG_LENGTH;
/** Derive a deterministic 16-byte salt from a file path via SHA-256. */
function pathSalt(path) {
    return createHash('sha256').update(path).digest().subarray(0, 16);
}
/** Derive an AES-256 key from a passphrase + path-based salt using Argon2id. */
async function deriveKey(passphrase, salt) {
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
function encrypt(plaintext, key) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
}
/** Decrypt wire-format bytes, returning plaintext. Throws StorageDecryptionError on failure. */
function decrypt(data, key, path) {
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
    }
    catch {
        throw new StorageDecryptionError(path, 'authentication failed (wrong key or corrupted data)');
    }
}
export class CryptoStorage {
    inner;
    passphrase;
    /** Cached derived keys, keyed by normalized file path. */
    keyCache = new Map();
    /**
     * @param inner  The underlying storage backend.
     * @param passphrase  Used only for Argon2id key derivation (stored for lazy per-path derivation).
     */
    constructor(inner, passphrase) {
        this.inner = inner;
        this.passphrase = passphrase;
    }
    /** Get or derive the AES-256 key for a given path. */
    async getKey(path) {
        const cached = this.keyCache.get(path);
        if (cached)
            return cached;
        const salt = pathSalt(path);
        const key = await deriveKey(this.passphrase, salt);
        this.keyCache.set(path, key);
        return key;
    }
    // --- Content-intercepting methods (encrypt/decrypt) --------------------
    async read(path) {
        const raw = await this.inner.readBytes(path);
        if (raw === null)
            return null;
        const key = await this.getKey(path);
        const plaintext = decrypt(raw, key, path);
        return plaintext.toString('utf-8');
    }
    async readBytes(path) {
        const raw = await this.inner.readBytes(path);
        if (raw === null)
            return null;
        const key = await this.getKey(path);
        return decrypt(raw, key, path);
    }
    async write(path, content, opts) {
        const plaintext = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
        const key = await this.getKey(path);
        const encrypted = encrypt(plaintext, key);
        return this.inner.write(path, encrypted, opts);
    }
    async writeAtomic(path, content, opts) {
        const plaintext = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
        const key = await this.getKey(path);
        const encrypted = encrypt(plaintext, key);
        return this.inner.writeAtomic(path, encrypted, opts);
    }
    async append(path, content) {
        const raw = await this.inner.readBytes(path);
        const key = await this.getKey(path);
        let existing;
        if (raw === null) {
            existing = '';
        }
        else {
            const plaintext = decrypt(raw, key, path);
            existing = plaintext.toString('utf-8');
        }
        const combined = Buffer.from(existing + content, 'utf-8');
        const encrypted = encrypt(combined, key);
        return this.inner.write(path, encrypted);
    }
    // --- Pass-through methods (no content, just metadata/structure) --------
    async exists(path) {
        return this.inner.exists(path);
    }
    async mtime(path) {
        return this.inner.mtime(path);
    }
    async list(dir) {
        return this.inner.list(dir);
    }
    async listEntries(dir) {
        return this.inner.listEntries(dir);
    }
    async mkdir(dir) {
        return this.inner.mkdir(dir);
    }
    async remove(path, opts) {
        return this.inner.remove(path, opts);
    }
    async rename(from, to) {
        return this.inner.rename(from, to);
    }
    async chmod(path, mode) {
        return this.inner.chmod(path, mode);
    }
}
export function createCryptoStorage(inner, passphrase) {
    return new CryptoStorage(inner, passphrase);
}
