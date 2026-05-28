export class StorageDecryptionError extends Error {
    code = 'storage-decryption';
    path;
    constructor(path, reason) {
        super(`Decryption failed for ${path}: ${reason}`);
        this.name = 'StorageDecryptionError';
        this.path = path;
    }
}
