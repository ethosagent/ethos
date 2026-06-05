import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';

// Read/write `~/.ethos/config.yaml` from the web side. The file is shared
// with the CLI (`apps/ethos/src/config.ts`), so any web-driven update must
// PRESERVE keys this layer doesn't know about (telegramToken, slack*,
// email*, etc.) — otherwise switching personalities or rotating an API key
// from the web would silently delete the user's gateway tokens.
//
// Stays as a web-api-internal repository (vs collapsing into the CLI's
// config.ts) because the passthrough-preserving parser is web-specific —
// the CLI's reader knows every key by name and would drop unknowns.

export interface ConfigRepositoryOptions {
  /** Where `~/.ethos` lives. config.yaml is `<dataDir>/config.yaml`. */
  dataDir: string;
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

/** A single entry in the provider chain (providers.N.* lines in config.yaml). */
export interface RawProviderEntry {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** Parsed shape — only the fields the web surface reads. Unknown keys are
 *  retained internally on the `_raw` map so writes preserve them. */
export interface RawConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  personality?: string;
  memory?: 'markdown' | 'vector';
  baseUrl?: string;
  /** Active skin name (default | mono | paper, or future custom skins). */
  skin?: string;
  approvalMode?: 'manual' | 'smart' | 'off';
  verbosity?: 'concise' | 'balanced' | 'verbose';
  debugMode?: boolean;
  contextLayering?: boolean;
  modelRouting: Record<string, string>;
  /** Ordered provider chain for ChainedProvider failover. */
  providers: RawProviderEntry[];
  /** Every other top-level key the file contained (telegramToken etc.).
   *  Round-tripped through writes verbatim. */
  passthrough: Record<string, string>;
}

export class ConfigRepository {
  private readonly storage: Storage;
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: ConfigRepositoryOptions) {
    this.storage = opts.storage ?? new FsStorage();
    this.path = join(opts.dataDir, 'config.yaml');
  }

  async exists(): Promise<boolean> {
    return this.storage.exists(this.path);
  }

  async read(): Promise<RawConfig | null> {
    const src = await this.storage.read(this.path);
    if (src === null) return null;

    const known = new Set([
      'provider',
      'model',
      'apiKey',
      'personality',
      'memory',
      'baseUrl',
      'skin',
      'approvalMode',
      'verbosity',
      'debugMode',
      'contextLayering',
    ]);
    const config: RawConfig = { modelRouting: {}, providers: [], passthrough: {} };
    const providerMap = new Map<number, RawProviderEntry>();

    for (const line of src.split('\n')) {
      // `providers.<n>.<field>: <value>` — provider chain entries
      const pm = line.match(/^providers\.(\d+)\.(\S+):\s*(.+)$/);
      if (pm) {
        const idx = Number(pm[1]);
        const field = pm[2]?.trim();
        const value = pm[3] !== undefined ? stripQuotes(pm[3].trim()) : '';
        if (field && !Number.isNaN(idx)) {
          let entry = providerMap.get(idx);
          if (!entry) {
            entry = { provider: '' };
            providerMap.set(idx, entry);
          }
          switch (field) {
            case 'provider':
              entry.provider = value;
              break;
            case 'apiKey':
              entry.apiKey = value;
              break;
            case 'model':
              entry.model = value;
              break;
            case 'baseUrl':
              entry.baseUrl = value;
              break;
          }
        }
        continue;
      }

      // `modelRouting.<id>: <model>` — per-personality overrides
      const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
      if (mr) {
        const id = mr[1]?.trim();
        const value = mr[2]?.trim();
        if (id && value) config.modelRouting[id] = stripQuotes(value);
        continue;
      }
      const kv = line.match(/^([\w.]+):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1]?.trim();
      const value = kv[2] !== undefined ? stripQuotes(kv[2].trim()) : '';
      if (!key) continue;

      if (known.has(key)) {
        switch (key) {
          case 'provider':
            config.provider = value;
            break;
          case 'model':
            config.model = value;
            break;
          case 'apiKey':
            config.apiKey = value;
            break;
          case 'personality':
            config.personality = value;
            break;
          case 'memory':
            config.memory = value === 'vector' ? 'vector' : 'markdown';
            break;
          case 'baseUrl':
            config.baseUrl = value;
            break;
          case 'skin':
            config.skin = value;
            break;
          case 'approvalMode':
            if (value === 'manual' || value === 'smart' || value === 'off') {
              config.approvalMode = value;
            }
            break;
          case 'verbosity':
            if (value === 'concise' || value === 'balanced' || value === 'verbose') {
              config.verbosity = value;
            }
            break;
          case 'debugMode':
            config.debugMode = value === 'true';
            break;
          case 'contextLayering':
            config.contextLayering = value === 'true';
            break;
        }
      } else {
        config.passthrough[key] = value;
      }
    }

    // Assemble providers array from indexed map, sorted by index
    const sortedIndices = [...providerMap.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const entry = providerMap.get(idx);
      if (entry) config.providers.push(entry);
    }

    return config;
  }

  /**
   * Apply a partial update. Reads the existing file, merges the patch in
   * place, writes back preserving order-of-keys for known fields and the
   * raw passthrough block beneath. New file (no prior config) is created
   * with just the provided keys.
   *
   * NOTE: `passthrough` merges on top of current — this method can only
   * ADD or OVERWRITE keys, never delete. Use `deletePassthroughKeys` for
   * deletion (e.g. clearing a platform's tokens).
   */
  async update(patch: Partial<RawConfig>): Promise<RawConfig> {
    let next!: RawConfig;
    const op = this.writeChain
      .catch(() => {})
      .then(async () => {
        const current: RawConfig = (await this.read()) ?? {
          modelRouting: {},
          providers: [],
          passthrough: {},
        };
        next = {
          ...current,
          ...patch,
          modelRouting: { ...current.modelRouting, ...(patch.modelRouting ?? {}) },
          // When providers is explicitly provided in the patch, replace entirely;
          // otherwise keep the current array.
          providers: patch.providers !== undefined ? patch.providers : current.providers,
          passthrough: { ...current.passthrough, ...(patch.passthrough ?? {}) },
        };
        await this.write(next);
      });
    this.writeChain = op.catch(() => {});
    await op;
    return next;
  }

  /**
   * Drop the named keys from the passthrough block and write the file
   * back. Used by the Communications tab's "Clear" action when a user
   * wants to disconnect a platform — the merge in `update` can't
   * delete keys, so this is the dedicated path.
   */
  async deletePassthroughKeys(keys: string[]): Promise<RawConfig> {
    let current!: RawConfig;
    const op = this.writeChain
      .catch(() => {})
      .then(async () => {
        current = (await this.read()) ?? { modelRouting: {}, providers: [], passthrough: {} };
        for (const key of keys) delete current.passthrough[key];
        await this.write(current);
      });
    this.writeChain = op.catch(() => {});
    await op;
    return current;
  }

  private async write(config: RawConfig): Promise<void> {
    await this.storage.mkdir(dirname(this.path));

    const lines: string[] = [];
    if (config.provider) lines.push(`provider: ${yamlScalar(config.provider)}`);
    if (config.model) lines.push(`model: ${yamlScalar(config.model)}`);
    if (config.apiKey) lines.push(`apiKey: ${yamlScalar(config.apiKey)}`);
    if (config.personality) lines.push(`personality: ${yamlScalar(config.personality)}`);
    if (config.memory) lines.push(`memory: ${yamlScalar(config.memory)}`);
    if (config.baseUrl) lines.push(`baseUrl: ${yamlScalar(config.baseUrl)}`);
    if (config.skin) lines.push(`skin: ${yamlScalar(config.skin)}`);
    if (config.approvalMode) lines.push(`approvalMode: ${yamlScalar(config.approvalMode)}`);
    if (config.verbosity) lines.push(`verbosity: ${yamlScalar(config.verbosity)}`);
    if (config.debugMode !== undefined) lines.push(`debugMode: ${config.debugMode}`);
    if (config.contextLayering !== undefined) lines.push(`contextLayering: ${config.contextLayering}`);
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${yamlScalar(id)}: ${yamlScalar(model)}`);
    }
    for (let i = 0; i < config.providers.length; i++) {
      const p = config.providers[i];
      if (!p) continue;
      lines.push(`providers.${i}.provider: ${yamlScalar(p.provider)}`);
      if (p.apiKey) lines.push(`providers.${i}.apiKey: ${yamlScalar(p.apiKey)}`);
      if (p.model) lines.push(`providers.${i}.model: ${yamlScalar(p.model)}`);
      if (p.baseUrl) lines.push(`providers.${i}.baseUrl: ${yamlScalar(p.baseUrl)}`);
    }
    // Stable-order passthrough — keep keys the CLI cares about across
    // round-trips even if it adds new ones in the future.
    for (const key of Object.keys(config.passthrough).sort()) {
      lines.push(`${yamlScalar(key)}: ${yamlScalar(config.passthrough[key] ?? '')}`);
    }
    await this.storage.writeAtomic(this.path, `${lines.join('\n')}\n`);
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/** Escape a value for safe YAML scalar emission. If the value contains
 *  characters that could alter YAML structure (colons, newlines, special
 *  chars, leading/trailing whitespace), wrap it in JSON-style double
 *  quotes. This prevents newline injection that could create new
 *  top-level keys (e.g. injecting `fs_reach` for privilege escalation). */
function yamlScalar(value: string): string {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}
