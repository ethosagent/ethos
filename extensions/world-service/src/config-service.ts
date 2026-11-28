// WorldConfigService: the single writer of `<dataDir>/worlds/<slug>/world.yaml`
// and `<dataDir>/personalities/<id>/worlds.yaml` (plan world-model Task 2.5;
// single-owner list in docs/decisions/0012-world-graph-contract.md).
//
// It holds COMPOSE-TIME Storage, handed in by wiring and reached only from the
// owner surfaces (web-api, CLI). A turn's Storage cannot reach either file:
// `worlds/` is on the state-dir deny list and `worlds.yaml` is a
// personality-definition entry, both pinned by
// packages/wiring/src/__tests__/world-floor.test.ts. The `Storage` type cannot
// tell a compose-time instance from a scoped one, so "never a turn's" is a
// wiring rule (only owner surfaces construct this class), not a type check.
//
// Provenance: each write prepends a one-line YAML comment
// `# written by <by> at <ISO time>`. The schemas are `.strict()`, so a sidecar
// field would be an unknown key; a comment survives `parseWorldYaml` and
// costs no schema change. It records the LAST writer only, and a hand edit
// that drops the comment is not detected.

import type { Storage } from '@ethosagent/types';
import { assertSafeId } from '@ethosagent/types';
import { stringify } from 'yaml';
import type { z } from 'zod';
import {
  type ConfigIssue,
  type MountsFile,
  MountsFileSchema,
  parseMountsYaml,
  parseWorldYaml,
  WorldConfigError,
  type WorldFile,
  WorldFileSchema,
} from './config';

/** Zod issues from a failed `safeParse`, as the `{ line, message }` shape of 2.1 (no text, so line 1). */
function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((i) => ({
    line: 1,
    message:
      i.code === 'unrecognized_keys'
        ? `unknown key "${i.keys.join('", "')}"`
        : `${i.path.join('.')}${i.path.length > 0 ? ': ' : ''}${i.message}`,
  }));
}

export interface WorldConfigServiceOptions {
  /** Compose-time Storage (never a turn's). */
  storage: Storage;
  /** The wired data directory: `<dataDir>/worlds`, `<dataDir>/personalities`. */
  dataDir: string;
  /** Test seam for the provenance timestamp. */
  now?: () => Date;
}

export interface WriteMeta {
  /** Who is writing, e.g. `cli:owner`, `web:<user>`. Recorded in the header. */
  by: string;
}

export class WorldConfigService {
  private readonly storage: Storage;
  private readonly dataDir: string;
  private readonly now: () => Date;

  constructor(opts: WorldConfigServiceOptions) {
    this.storage = opts.storage;
    this.dataDir = opts.dataDir.replace(/\/+$/, '');
    this.now = opts.now ?? (() => new Date());
  }

  private worldPath(slug: string): string {
    return `${this.dataDir}/worlds/${slug}/world.yaml`;
  }

  private mountsPath(personalityId: string): string {
    return `${this.dataDir}/personalities/${personalityId}/worlds.yaml`;
  }

  /**
   * Validate with the 2.1 schema (unknown keys refused, duplicate readers and
   * proposers refused via `parseWorldYaml`), then `writeAtomic`. The file
   * is validated by re-parsing the exact text that is written, so what lands
   * on disk is what `readWorld` accepts.
   */
  async writeWorld(world: unknown, meta: WriteMeta): Promise<WorldFile> {
    const parsed = WorldFileSchema.safeParse(world);
    if (!parsed.success) {
      throw new WorldConfigError('world.yaml', schemaIssues(parsed.error));
    }
    const text = this.render(parsed.data, meta);
    const checked = parseWorldYaml(text);
    const dir = `${this.dataDir}/worlds/${checked.id}`;
    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(this.worldPath(checked.id), text);
    return checked;
  }

  /**
   * Validate (rule 4: aliases unique per personality, never another mount's
   * slug, via `parseMountsYaml`) and write `personalities/<id>/worlds.yaml`.
   */
  async writeMounts(personalityId: string, mounts: unknown, meta: WriteMeta): Promise<MountsFile> {
    assertSafeId(personalityId, 'personality id');
    const parsed = MountsFileSchema.safeParse(mounts);
    if (!parsed.success) {
      throw new WorldConfigError('worlds.yaml', schemaIssues(parsed.error));
    }
    const text = this.render(parsed.data, meta);
    const checked = parseMountsYaml(text);
    await this.storage.mkdir(`${this.dataDir}/personalities/${personalityId}`);
    await this.storage.writeAtomic(this.mountsPath(personalityId), text);
    return checked;
  }

  /** One world, re-validated on load (a hand edit is re-checked). Null when absent. */
  async readWorld(slug: string): Promise<WorldFile | null> {
    assertSafeId(slug, 'world slug');
    const text = await this.storage.read(this.worldPath(slug));
    return text === null ? null : parseWorldYaml(text);
  }

  /**
   * Every `worlds/<slug>/world.yaml`, keyed by slug, in the shape
   * `resolveAccess` takes. A directory with no world.yaml is skipped; a file
   * that fails validation throws `WorldConfigError` (fail loud, never drop a
   * world silently), and one whose `id` differs from its directory is refused.
   */
  async listWorlds(): Promise<ReadonlyMap<string, WorldFile>> {
    const out = new Map<string, WorldFile>();
    const entries = await this.storage.listEntries(`${this.dataDir}/worlds`);
    for (const entry of entries
      .filter((e) => e.isDir)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const text = await this.storage.read(this.worldPath(entry.name));
      if (text === null) continue;
      const world = parseWorldYaml(text);
      if (world.id !== entry.name) {
        throw new WorldConfigError(`worlds/${entry.name}/world.yaml`, [
          { line: 1, message: `id "${world.id}" does not match its directory "${entry.name}"` },
        ]);
      }
      out.set(world.id, world);
    }
    return out;
  }

  /** A personality's mounts, re-validated on load. No file means no mounts. */
  async readMounts(personalityId: string): Promise<MountsFile> {
    assertSafeId(personalityId, 'personality id');
    const text = await this.storage.read(this.mountsPath(personalityId));
    return text === null ? { mounts: [] } : parseMountsYaml(text);
  }

  private render(value: WorldFile | MountsFile, meta: WriteMeta): string {
    const by = meta.by.replace(/[\r\n]+/g, ' ');
    return `# written by ${by} at ${this.now().toISOString()}\n${stringify(value)}`;
  }
}
