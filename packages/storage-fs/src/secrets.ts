import { dirname, join } from 'node:path';
import type { SecretRef, SecretsResolver, Storage } from '@ethosagent/types';

export interface FileSecretsResolverOptions {
  dir: string;
  storage: Storage;
}

/**
 * Reject refs that could escape the secrets directory or create ambiguous
 * paths. Throws with a descriptive message on violation.
 */
function validateRef(ref: string): void {
  if (ref === '') {
    throw new Error('Secret ref must not be empty');
  }
  if (ref.includes('\0')) {
    throw new Error('Secret ref must not contain NUL bytes');
  }
  if (ref.includes('\\')) {
    throw new Error(`Secret ref must not contain backslashes: ${ref}`);
  }
  if (ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) {
    throw new Error(`Secret ref must not be an absolute path: ${ref}`);
  }
  if (ref.split('/').some((seg) => seg === '..')) {
    throw new Error(`Secret ref must not contain "..": ${ref}`);
  }
  if (ref.split('/').some((seg) => seg === '')) {
    throw new Error(`Secret ref must not contain empty segments: ${ref}`);
  }
}

/**
 * File-backed SecretsResolver. Stores each secret as a plain-text file under
 * `opts.dir`, using the injected Storage for all I/O. File permissions are
 * set to 0o600 (owner-only read/write) via writeAtomic.
 */
export class FileSecretsResolver implements SecretsResolver {
  constructor(private readonly opts: FileSecretsResolverOptions) {}

  async get(ref: SecretRef): Promise<string | null> {
    validateRef(ref);
    const content = await this.opts.storage.read(join(this.opts.dir, ref));
    if (content === null) return null;
    return content.replace(/\n$/, '');
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    validateRef(ref);
    const path = join(this.opts.dir, ref);
    await this.opts.storage.mkdir(dirname(path));
    await this.opts.storage.writeAtomic(path, `${value}\n`, { mode: 0o600 });
  }

  async delete(ref: SecretRef): Promise<void> {
    validateRef(ref);
    await this.opts.storage.remove(join(this.opts.dir, ref)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async list(prefix?: string): Promise<SecretRef[]> {
    const entries = await this.walkDir(this.opts.dir);
    const base = this.opts.dir.endsWith('/') ? this.opts.dir : `${this.opts.dir}/`;
    const refs = entries.map((e) => e.slice(base.length));
    if (!prefix) return refs;
    return refs.filter((r) => r.startsWith(prefix));
  }

  private async walkDir(dir: string): Promise<string[]> {
    const entries = await this.opts.storage.listEntries(dir).catch(() => []);
    const result: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDir) {
        result.push(...(await this.walkDir(fullPath)));
      } else {
        result.push(fullPath);
      }
    }
    return result;
  }
}

/**
 * In-memory SecretsResolver for tests. No filesystem, no validation overhead.
 */
export class InMemorySecretsResolver implements SecretsResolver {
  private readonly store = new Map<SecretRef, string>();

  async get(ref: SecretRef): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    this.store.set(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    this.store.delete(ref);
  }

  async list(prefix?: string): Promise<SecretRef[]> {
    const all = [...this.store.keys()];
    if (!prefix) return all;
    return all.filter((r) => r.startsWith(prefix));
  }
}
