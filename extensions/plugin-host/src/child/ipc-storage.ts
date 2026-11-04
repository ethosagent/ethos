import type { Storage, StorageDirEntry } from '@ethosagent/types';

/** Bytes cross JSON as `{ $bytes: <base64> }`. */
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  return value;
}

function decode(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$bytes' in value &&
    typeof value.$bytes === 'string'
  ) {
    return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
  }
  return value;
}

export type CapabilityCall = (op: string, args: unknown[]) => Promise<unknown>;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * `ctx.storage` for a hosted tool: every method is one
 * `ethos/capability.storage` request, answered in the parent by the call's own
 * `ScopedStorage` (plan §5.6). The parent-side server is lane C's.
 */
export class IpcStorage implements Storage {
  constructor(private readonly call: CapabilityCall) {}

  read(path: string): Promise<string | null> {
    return this.call('read', [path]).then(nullableString);
  }
  async readBytes(path: string): Promise<Uint8Array | null> {
    const out = decode(await this.call('readBytes', [path]));
    return out instanceof Uint8Array ? out : null;
  }
  async exists(path: string): Promise<boolean> {
    return (await this.call('exists', [path])) === true;
  }
  async mtime(path: string): Promise<number | null> {
    const out = await this.call('mtime', [path]);
    return typeof out === 'number' ? out : null;
  }
  async list(dir: string): Promise<string[]> {
    return stringArray(await this.call('list', [dir]));
  }
  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const out = await this.call('listEntries', [dir]);
    if (!Array.isArray(out)) return [];
    const entries: StorageDirEntry[] = [];
    for (const item of out) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'name' in item &&
        typeof item.name === 'string' &&
        'isDir' in item &&
        typeof item.isDir === 'boolean'
      ) {
        entries.push({ name: item.name, isDir: item.isDir });
      }
    }
    return entries;
  }
  async write(path: string, content: string | Uint8Array, opts?: { mode?: number }): Promise<void> {
    await this.call('write', [path, encode(content), opts]);
  }
  async append(path: string, content: string): Promise<void> {
    await this.call('append', [path, content]);
  }
  async writeAtomic(
    path: string,
    content: string | Uint8Array,
    opts?: { mode?: number },
  ): Promise<void> {
    await this.call('writeAtomic', [path, encode(content), opts]);
  }
  async mkdir(dir: string): Promise<void> {
    await this.call('mkdir', [dir]);
  }
  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.call('remove', [path, opts]);
  }
  async rename(from: string, to: string): Promise<void> {
    await this.call('rename', [from, to]);
  }
  async chmod(path: string, mode: number): Promise<void> {
    await this.call('chmod', [path, mode]);
  }
}
