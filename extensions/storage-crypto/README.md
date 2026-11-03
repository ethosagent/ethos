# @ethosagent/storage-crypto

## Purpose

An encryption decorator over any `Storage`. `CryptoStorage` encrypts file contents with AES-256-GCM under a key derived from a passphrase with Argon2id, and passes directory and metadata calls straight through to the inner storage. It does not choose where bytes live or manage the passphrase; the inner `Storage` and the caller do.

## Public surface

Single entry point `.` (`src/index.ts`).

| Export | Kind | One line |
|---|---|---|
| `CryptoStorage` | class | `Storage` decorator that encrypts on write and decrypts on read. |
| `createCryptoStorage` | function | `createCryptoStorage(inner, passphrase)` returns a `CryptoStorage`. |
| `StorageDecryptionError` | class | Thrown on a wrong key, tampered data or data too short to be encrypted. |

On-disk format (v1) is `ETHC`, a version byte, a random 16-byte salt per file, IV, GCM tag, ciphertext, with the 21 header bytes bound as additional authenticated data. Files in the older path-salted v0 layout are still read and are rewritten as v1 on the next write.

## Seam

Implements `Storage` from `@ethosagent/types` (`implements` on `CryptoStorage` in `src/crypto-storage.ts`). Layer `extensions`. The format guarantees are pinned by `src/__tests__/wire-format.test.ts` (random salt not derived from the path, rename keeps a file readable, tampering detected in every region of a v1 file, v0 read then rewritten as v1). Limitation: the passphrase is held in memory for the life of the instance, and no test pins its lifetime.

## Testing

```
pnpm vitest run extensions/storage-crypto
```

- `src/__tests__/crypto-storage.test.ts`: string and byte round trips, `write`, `writeAtomic` and `append`, null for a missing file, wrong key and tampered data throw `StorageDecryptionError`, ciphertext in the inner storage is not plaintext, pass-through methods.
- `src/__tests__/wire-format.test.ts`: v1 header, per-file random salt, round trip across independent instances, rename, v0 read and upgrade, tamper detection.
