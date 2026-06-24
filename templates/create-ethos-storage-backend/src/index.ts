import type { EthosPlugin, EthosPluginApi, Storage, StorageFactory } from '@ethosagent/plugin-sdk';
import type { StorageDirEntry, StorageRemoveOptions, StorageWriteOptions } from '@ethosagent/types';

class MyStorage implements Storage {
  async read(_path: string): Promise<string | null> {
    throw new Error('Not implemented');
  }

  async readBytes(_path: string): Promise<Uint8Array | null> {
    throw new Error('Not implemented');
  }

  async exists(_path: string): Promise<boolean> {
    throw new Error('Not implemented');
  }

  async mtime(_path: string): Promise<number | null> {
    throw new Error('Not implemented');
  }

  async list(_dir: string): Promise<string[]> {
    throw new Error('Not implemented');
  }

  async listEntries(_dir: string): Promise<StorageDirEntry[]> {
    throw new Error('Not implemented');
  }

  async write(
    _path: string,
    _content: string | Uint8Array,
    _opts?: StorageWriteOptions,
  ): Promise<void> {
    throw new Error('Not implemented');
  }

  async append(_path: string, _content: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async writeAtomic(
    _path: string,
    _content: string | Uint8Array,
    _opts?: StorageWriteOptions,
  ): Promise<void> {
    throw new Error('Not implemented');
  }

  async mkdir(_dir: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async remove(_path: string, _opts?: StorageRemoveOptions): Promise<void> {
    throw new Error('Not implemented');
  }

  async rename(_from: string, _to: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // No-op for non-POSIX backends
  }
}

const factory: StorageFactory = ({ config: _config, secrets: _secrets, logger: _logger }) => {
  return new MyStorage();
};

const plugin: EthosPlugin = {
  activate(api: EthosPluginApi) {
    api.registerStorage('my-backend', factory);
  },
};

export default plugin;
