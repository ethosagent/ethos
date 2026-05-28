import { FsStorage } from '@ethosagent/storage-fs';
// Serializes writes via promise chain so concurrent tasks don't interleave bytes.
export class AtroposWriter {
  path;
  chain = Promise.resolve();
  storage;
  constructor(path, storage = new FsStorage()) {
    this.path = path;
    this.storage = storage;
  }
  async init(truncate) {
    if (truncate) await this.storage.write(this.path, '');
  }
  append(record) {
    this.chain = this.chain.then(() =>
      this.storage.append(this.path, `${JSON.stringify(record)}\n`),
    );
    return this.chain;
  }
}
