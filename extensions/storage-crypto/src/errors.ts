export class StorageDecryptionError extends Error {
  readonly code = 'storage-decryption' as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Decryption failed for ${path}: ${reason}`);
    this.name = 'StorageDecryptionError';
    this.path = path;
  }
}
