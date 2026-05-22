import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CryptoStorage, createCryptoStorage, StorageDecryptionError } from '../index';

const KEY_A = 'test-passphrase-alpha';
const KEY_B = 'test-passphrase-beta';

describe('CryptoStorage', () => {
  let inner: InMemoryStorage;
  let crypto: CryptoStorage;

  beforeEach(() => {
    inner = new InMemoryStorage();
    crypto = createCryptoStorage(inner, KEY_A);
  });

  // 1. Round-trip
  it('round-trips a string through write/read', async () => {
    await inner.mkdir('/data');
    await crypto.write('/data/hello.txt', 'hello world');
    const result = await crypto.read('/data/hello.txt');
    expect(result).toBe('hello world');
  });

  // 2. Binary round-trip
  it('round-trips a Uint8Array through write/readBytes', async () => {
    await inner.mkdir('/data');
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    await crypto.write('/data/bin.dat', bytes);
    const result = await crypto.readBytes('/data/bin.dat');
    expect(result).not.toBeNull();
    expect(new Uint8Array(result ?? new Uint8Array())).toEqual(bytes);
  });

  // 3. writeAtomic round-trip
  it('round-trips a string through writeAtomic/read', async () => {
    await inner.mkdir('/data');
    await crypto.writeAtomic('/data/atomic.txt', 'atomic content');
    const result = await crypto.read('/data/atomic.txt');
    expect(result).toBe('atomic content');
  });

  // 4. Append
  it('appends content correctly', async () => {
    await inner.mkdir('/data');
    await crypto.write('/data/log.txt', 'first ');
    await crypto.append('/data/log.txt', 'second');
    const result = await crypto.read('/data/log.txt');
    expect(result).toBe('first second');
  });

  // 5. Missing file
  it('returns null for a missing file via read', async () => {
    expect(await crypto.read('/nonexistent.txt')).toBeNull();
  });

  it('returns null for a missing file via readBytes', async () => {
    expect(await crypto.readBytes('/nonexistent.txt')).toBeNull();
  });

  // 6. Empty string
  it('round-trips an empty string (not null)', async () => {
    await inner.mkdir('/data');
    await crypto.write('/data/empty.txt', '');
    const result = await crypto.read('/data/empty.txt');
    expect(result).toBe('');
  });

  // 7. Wrong key
  it('throws StorageDecryptionError when reading with a different key', async () => {
    await inner.mkdir('/data');
    await crypto.write('/data/secret.txt', 'secret');

    const wrongCrypto = createCryptoStorage(inner, KEY_B);
    await expect(wrongCrypto.read('/data/secret.txt')).rejects.toThrow(StorageDecryptionError);
  });

  // 8. Tamper detection
  it('throws StorageDecryptionError when encrypted data is tampered with', async () => {
    await inner.mkdir('/data');
    await crypto.write('/data/tamper.txt', 'pristine');

    // Read raw encrypted bytes from inner storage
    const raw = await inner.readBytes('/data/tamper.txt');
    expect(raw).not.toBeNull();
    const tampered = new Uint8Array(raw ?? new Uint8Array());
    // Flip the last byte
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;
    await inner.write('/data/tamper.txt', tampered);

    await expect(crypto.read('/data/tamper.txt')).rejects.toThrow(StorageDecryptionError);
  });

  // 9. Data too short
  it('throws StorageDecryptionError when raw data is shorter than header', async () => {
    await inner.mkdir('/data');
    // Write less than 28 bytes (IV 12 + tag 16 = 28) directly to inner
    const tooShort = new Uint8Array([1, 2, 3, 4, 5]);
    await inner.write('/data/short.dat', tooShort);

    await expect(crypto.read('/data/short.dat')).rejects.toThrow(StorageDecryptionError);
  });

  // 10. Pass-through methods
  describe('pass-through methods', () => {
    it('exists returns true for a written file', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/exists.txt', 'yes');
      expect(await crypto.exists('/data/exists.txt')).toBe(true);
    });

    it('exists returns false for a missing file', async () => {
      expect(await crypto.exists('/data/nope.txt')).toBe(false);
    });

    it('mtime returns a number for a written file', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/mt.txt', 'x');
      const mt = await crypto.mtime('/data/mt.txt');
      expect(mt).not.toBeNull();
      expect(typeof mt).toBe('number');
    });

    it('mtime returns null for a missing file', async () => {
      expect(await crypto.mtime('/nope.txt')).toBeNull();
    });

    it('list returns directory entries', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/a.txt', 'a');
      await crypto.write('/data/b.txt', 'b');
      const names = await crypto.list('/data');
      expect(names).toContain('a.txt');
      expect(names).toContain('b.txt');
    });

    it('listEntries returns entries with isDir flag', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/f.txt', 'x');
      await crypto.mkdir('/data/sub');
      const entries = await crypto.listEntries('/data');
      const file = entries.find((e) => e.name === 'f.txt');
      const dir = entries.find((e) => e.name === 'sub');
      expect(file).toEqual({ name: 'f.txt', isDir: false });
      expect(dir).toEqual({ name: 'sub', isDir: true });
    });

    it('mkdir creates a directory', async () => {
      await crypto.mkdir('/newdir');
      expect(await inner.exists('/newdir')).toBe(true);
    });

    it('remove deletes a file', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/rm.txt', 'bye');
      await crypto.remove('/data/rm.txt');
      expect(await inner.exists('/data/rm.txt')).toBe(false);
    });

    it('rename moves a file', async () => {
      await inner.mkdir('/data');
      await crypto.write('/data/old.txt', 'content');
      await crypto.rename('/data/old.txt', '/data/new.txt');
      expect(await inner.exists('/data/old.txt')).toBe(false);
      expect(await inner.exists('/data/new.txt')).toBe(true);
    });
  });

  // 11. Encrypted data is not plaintext
  it('encrypted data in inner storage is not plaintext', async () => {
    await inner.mkdir('/data');
    const plaintext = 'this is secret data';
    await crypto.write('/data/enc.txt', plaintext);

    const rawStr = await inner.read('/data/enc.txt');
    // The raw content should not equal the plaintext — it's encrypted binary
    expect(rawStr).not.toBe(plaintext);

    const rawBytes = await inner.readBytes('/data/enc.txt');
    expect(rawBytes).not.toBeNull();
    const decoded = new TextDecoder().decode(rawBytes ?? new Uint8Array());
    expect(decoded).not.toBe(plaintext);
  });

  // 12. Different paths get different ciphertext
  it('same content written to different paths produces different ciphertext', async () => {
    await inner.mkdir('/data');
    const content = 'identical';
    await crypto.write('/data/path-a.txt', content);
    await crypto.write('/data/path-b.txt', content);

    const rawA = await inner.readBytes('/data/path-a.txt');
    const rawB = await inner.readBytes('/data/path-b.txt');
    expect(rawA).not.toBeNull();
    expect(rawB).not.toBeNull();

    // The encrypted blobs must differ (different path salt + random IV)
    const bytesA = new Uint8Array(rawA ?? new Uint8Array());
    const bytesB = new Uint8Array(rawB ?? new Uint8Array());

    // Compare as hex strings for a clear assertion message
    const hexA = Buffer.from(bytesA).toString('hex');
    const hexB = Buffer.from(bytesB).toString('hex');
    expect(hexA).not.toBe(hexB);
  });
});
