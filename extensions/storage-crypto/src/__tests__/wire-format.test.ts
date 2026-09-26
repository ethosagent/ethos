// SEC-002 — the on-disk wire format. v1 is self-describing
// (`[ "ETHC" ][ version ][ salt ][ IV ][ tag ][ ciphertext ]`) with a RANDOM
// per-file salt; v0 (`[ IV ][ tag ][ ciphertext ]`, key salted with
// sha256(path)) stays readable so files written before v1 are not bricked.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import argon2 from 'argon2';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CryptoStorage, createCryptoStorage, StorageDecryptionError } from '../index';

const KEY = 'test-passphrase-alpha';
const MAGIC = Buffer.from('ETHC', 'ascii');
// magic (4) + version (1) + salt (16)
const SALT_OFFSET = 5;
const SALT_END = SALT_OFFSET + 16;
// Every key derivation is Argon2id at 64 MiB; under a parallel suite a test that
// derives several keys needs more than the global 15 s.
const SLOW = 90_000;

/** Build a v0 blob exactly as the pre-v1 CryptoStorage wrote it. */
async function legacyV0(path: string, plaintext: string): Promise<Uint8Array> {
  const salt = createHash('sha256').update(path).digest().subarray(0, 16);
  const key = await argon2.hash(KEY, {
    salt,
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 1,
    hashLength: 32,
    raw: true,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

async function rawBytes(inner: InMemoryStorage, path: string): Promise<Buffer> {
  const raw = await inner.readBytes(path);
  if (raw === null) throw new Error(`no file at ${path}`);
  return Buffer.from(raw);
}

describe('CryptoStorage wire format (SEC-002)', () => {
  let inner: InMemoryStorage;
  let crypto: CryptoStorage;

  beforeEach(async () => {
    inner = new InMemoryStorage();
    await inner.mkdir('/data');
    crypto = createCryptoStorage(inner, KEY);
  }, SLOW);

  it(
    'writes a v1 header: magic "ETHC" then version 1',
    async () => {
      await crypto.write('/data/a.txt', 'hello');
      const raw = await rawBytes(inner, '/data/a.txt');
      expect(raw.subarray(0, 4).equals(MAGIC)).toBe(true);
      expect(raw[4]).toBe(1);
    },
    SLOW,
  );

  it(
    'salts each file randomly, not from its path',
    async () => {
      const other = createCryptoStorage(inner, KEY);
      await crypto.write('/data/a.txt', 'same');
      const rawA = await rawBytes(inner, '/data/a.txt');
      expect(rawA.subarray(0, 4).equals(MAGIC)).toBe(true);
      const saltA = rawA.subarray(SALT_OFFSET, SALT_END);
      // An independent instance writing the SAME path must not arrive at the same salt.
      await other.write('/data/a.txt', 'same');
      const saltB = (await rawBytes(inner, '/data/a.txt')).subarray(SALT_OFFSET, SALT_END);
      expect(saltA.equals(saltB)).toBe(false);
      const pathSalt = createHash('sha256').update('/data/a.txt').digest().subarray(0, 16);
      expect(saltA.equals(pathSalt)).toBe(false);
      expect(saltB.equals(pathSalt)).toBe(false);
    },
    SLOW,
  );

  it(
    'round-trips v1 across independent instances, write/writeAtomic/append',
    async () => {
      await crypto.write('/data/w.txt', 'written');
      await crypto.writeAtomic('/data/wa.txt', 'atomic');
      await crypto.write('/data/ap.txt', 'first ');
      await crypto.append('/data/ap.txt', 'second');
      const fresh = createCryptoStorage(inner, KEY);
      expect(await fresh.read('/data/w.txt')).toBe('written');
      expect(await fresh.read('/data/wa.txt')).toBe('atomic');
      expect(await fresh.read('/data/ap.txt')).toBe('first second');
    },
    SLOW,
  );

  it(
    'a renamed file still decrypts at its new path',
    async () => {
      await crypto.write('/data/MEMORY.md', 'remember this');
      await crypto.rename('/data/MEMORY.md', '/data/MEMORY.md.bak');
      expect(await crypto.read('/data/MEMORY.md.bak')).toBe('remember this');
      expect(await createCryptoStorage(inner, KEY).read('/data/MEMORY.md.bak')).toBe(
        'remember this',
      );
    },
    SLOW,
  );

  it(
    'reads a v0 file, and re-writes it as v1 on the next write',
    async () => {
      await inner.write('/data/old.txt', await legacyV0('/data/old.txt', 'legacy content'));
      expect(await crypto.read('/data/old.txt')).toBe('legacy content');
      await crypto.append('/data/old.txt', ' + more');
      const raw = await rawBytes(inner, '/data/old.txt');
      expect(raw.subarray(0, 4).equals(MAGIC)).toBe(true);
      expect(await createCryptoStorage(inner, KEY).read('/data/old.txt')).toBe(
        'legacy content + more',
      );
    },
    SLOW,
  );

  it(
    'detects tampering in every region of a v1 file',
    async () => {
      await crypto.write('/data/t.txt', 'pristine content');
      const original = await rawBytes(inner, '/data/t.txt');
      // version, salt, IV, tag, ciphertext
      const reader = createCryptoStorage(inner, KEY);
      for (const offset of [4, SALT_OFFSET, SALT_END, SALT_END + 12, original.length - 1]) {
        const tampered = Buffer.from(original);
        tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
        await inner.write('/data/t.txt', new Uint8Array(tampered));
        await expect(reader.read('/data/t.txt')).rejects.toThrow(StorageDecryptionError);
      }
    },
    SLOW,
  );

  it(
    'refuses a v1 file under the wrong passphrase',
    async () => {
      await crypto.write('/data/s.txt', 'secret');
      await expect(
        createCryptoStorage(inner, 'other-passphrase').read('/data/s.txt'),
      ).rejects.toThrow(StorageDecryptionError);
    },
    SLOW,
  );
});
