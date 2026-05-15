import { normalize, resolve } from 'node:path';
import type { ScopedFs, Storage } from '@ethosagent/types';

export class ScopedFsImpl implements ScopedFs {
  constructor(
    private readonly storage: Storage,
    private readonly readPaths: Set<string>,
    private readonly writePaths: Set<string>,
  ) {}

  async read(path: string): Promise<string> {
    this.checkReach(path, this.readPaths, 'read');
    const content = await this.storage.read(path);
    if (content === null) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, content: string | Buffer): Promise<void> {
    this.checkReach(path, this.writePaths, 'write');
    await this.storage.write(path, typeof content === 'string' ? content : new Uint8Array(content));
  }

  async exists(path: string): Promise<boolean> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.exists(path);
  }

  async list(path: string): Promise<string[]> {
    this.checkReach(path, this.readPaths, 'read');
    return this.storage.list(path);
  }

  private checkReach(path: string, allowed: Set<string>, kind: string): void {
    const canonical = normalize(resolve(path));
    for (const prefix of allowed) {
      const canonicalPrefix = normalize(resolve(prefix));
      if (
        canonical === canonicalPrefix ||
        canonical.startsWith(
          canonicalPrefix.endsWith('/') ? canonicalPrefix : `${canonicalPrefix}/`,
        )
      )
        return;
    }
    throw new Error(`PATH_NOT_REACHABLE: ${kind} not permitted for ${path}`);
  }
}
