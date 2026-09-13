// The isolation layer a replay run reads through (plan `trust-before-reach.md`
// Part 4, L-T3, Design section 3).
//
// A replay answers one question — "does this candidate do better than what is
// live?" — by running frozen cases against a loop that sees ONE path
// differently. `OverlayStorage` is that difference, and nothing more:
//
//   - a skill candidate shadows its `destination`, so the skills scanner reads
//     the candidate's bytes where the live file's would be (and SEES the file
//     at all when the candidate is a create — `listEntries` synthesizes the
//     entry, which is what `UniversalScanner.discoverFiles` walks);
//   - an Expression candidate shadows `soulFile` with
//     `serializeLivingSoul({ core, expression: candidate, learningLog })`, so
//     Core and the learning log are byte-identical to what is on disk and only
//     the Expression region differs. The bytes are computed by the CALLER
//     (`shadowForCandidate` in `packages/wiring/src/learning-replay.ts`) —
//     `serializeLivingSoul` lives in `@ethosagent/personalities`, and this
//     package deliberately depends on `@ethosagent/types` alone.
//
// Every write, append, remove, rename, mkdir and chmod through the overlay
// throws `BoundaryError`. A replay is a MEASUREMENT, not a run: nothing it does
// may reach disk, and a refusal that is loud is better than a write that is
// quiet. The baseline arm takes an overlay too, with no shadow — it measures
// what is already live, and it must not write either.
//
// WHAT THIS DOES NOT COVER, honestly (rule 12 — name the enforcer or record the
// limitation):
//
//   - Raw-SQLite stores do not go through `Storage` at all, so the overlay
//     cannot stop them: `outbox.db`, `jobs.db`, `sessions.db`, the delivery
//     ledger, the notify queue and every other store in CLAUDE.md's "Allowed
//     exceptions" list open a path directly through `@ethosagent/sqlite`.
//   - What actually keeps a replay from publishing is `RunOptions.dryRun`
//     (X-D6): `DefaultToolRegistry.executeParallel`
//     (`packages/core/src/tool-registry.ts`) returns `synthesizeDryRunResult`
//     WITHOUT calling `tool.execute`, so a tool never runs at all. The outbox
//     gate that would queue a `send_message` lives inside `executeSendMessage`
//     (`extensions/tools-messaging/src/index.ts`, O-D3) — inside the `execute`
//     that never runs — so a gated `send_message` in a dry-run plan creates no
//     outbox row. Both enforcers are pinned by
//     `packages/wiring/src/__tests__/replay-isolation.test.ts`.
//   - The overlay compares paths lexically (`node:path.resolve`), not by inode.
//     It follows the same symlinks the base storage does; a symlinked
//     `destination` is shadowed under the name it was given, not under its
//     target. `ScopedStorage` is the layer that polices symbolic containment.
//   - It synthesizes the shadowed FILE, never its ancestors. A `destination`
//     whose parent directory does not exist on disk is not made to appear,
//     because `mkdir` is refused like every other write.

import { basename, dirname, resolve } from 'node:path';
import {
  BoundaryError,
  type Storage,
  type StorageDirEntry,
  type StorageRemoveOptions,
  type StorageWriteOptions,
} from '@ethosagent/types';

/** The one path a replay arm sees differently, and the bytes it sees there. */
export interface OverlayShadow {
  /** Absolute path — a skill candidate's `destination`, or a personality's `soulFile`. */
  path: string;
  /** What `read` returns at `path`, whatever is (or is not) on disk. */
  content: string;
}

const WHY = 'replay overlay is read-only — a replay measures a candidate, it never writes';

export class OverlayStorage implements Storage {
  private readonly base: Storage;
  private readonly shadow: OverlayShadow | null;
  /** `resolve()`d once; every comparison is against this. */
  private readonly shadowPath: string | null;
  private readonly shadowDir: string | null;
  private readonly shadowName: string | null;
  private readonly shadowBytes: Uint8Array | null;
  /**
   * One fixed mtime for the shadowed path, taken at construction. Consumers
   * cache parsed content by mtime (`UniversalScanner.loadSkill`,
   * `FilePersonalityRegistry.loadFromDirectory`), so a stable value means one
   * parse per replay instead of one per read — and the shadow never changes
   * during a run.
   */
  private readonly shadowMtimeMs: number;

  constructor(base: Storage, shadow: OverlayShadow | null, opts?: { now?: () => number }) {
    this.base = base;
    this.shadow = shadow;
    this.shadowPath = shadow ? resolve(shadow.path) : null;
    this.shadowDir = this.shadowPath === null ? null : dirname(this.shadowPath);
    this.shadowName = this.shadowPath === null ? null : basename(this.shadowPath);
    this.shadowBytes = shadow ? new TextEncoder().encode(shadow.content) : null;
    this.shadowMtimeMs = (opts?.now ?? Date.now)();
  }

  private isShadow(path: string): boolean {
    return this.shadowPath !== null && resolve(path) === this.shadowPath;
  }

  private isShadowDir(dir: string): boolean {
    return this.shadowDir !== null && resolve(dir) === this.shadowDir;
  }

  // --- Reads ----------------------------------------------------------

  async read(path: string): Promise<string | null> {
    if (this.isShadow(path)) return this.shadow?.content ?? null;
    return this.base.read(path);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    if (this.isShadow(path)) return this.shadowBytes;
    return this.base.readBytes(path);
  }

  async exists(path: string): Promise<boolean> {
    if (this.isShadow(path)) return true;
    return this.base.exists(path);
  }

  async mtime(path: string): Promise<number | null> {
    if (this.isShadow(path)) return this.shadowMtimeMs;
    return this.base.mtime(path);
  }

  async list(dir: string): Promise<string[]> {
    const names = await this.base.list(dir);
    if (!this.isShadowDir(dir) || this.shadowName === null) return names;
    return names.includes(this.shadowName) ? names : [...names, this.shadowName];
  }

  async listEntries(dir: string): Promise<StorageDirEntry[]> {
    const entries = await this.base.listEntries(dir);
    if (!this.isShadowDir(dir) || this.shadowName === null) return entries;
    // A create must be VISIBLE, not just readable: the skills scanner walks
    // `listEntries` and never opens a file it did not list.
    const shadowEntry: StorageDirEntry = {
      name: this.shadowName,
      isDir: false,
      size: this.shadowBytes?.byteLength ?? 0,
      mtimeMs: this.shadowMtimeMs,
    };
    const at = entries.findIndex((e) => e.name === this.shadowName);
    if (at === -1) return [...entries, shadowEntry];
    // A rewrite: the live entry's size and mtime would describe the live bytes,
    // which is not what a read at this path returns.
    const merged = [...entries];
    merged[at] = shadowEntry;
    return merged;
  }

  // --- Writes: every one of them is refused ---------------------------

  async write(path: string, _content: string | Uint8Array, _opts?: StorageWriteOptions) {
    throw new BoundaryError('write', path, [], WHY);
  }

  async append(path: string, _content: string): Promise<void> {
    throw new BoundaryError('write', path, [], WHY);
  }

  async writeAtomic(path: string, _content: string | Uint8Array, _opts?: StorageWriteOptions) {
    throw new BoundaryError('write', path, [], WHY);
  }

  async mkdir(dir: string): Promise<void> {
    throw new BoundaryError('write', dir, [], WHY);
  }

  async remove(path: string, _opts?: StorageRemoveOptions): Promise<void> {
    throw new BoundaryError('write', path, [], WHY);
  }

  async rename(from: string, _to: string): Promise<void> {
    throw new BoundaryError('write', from, [], WHY);
  }

  async chmod(path: string, _mode: number): Promise<void> {
    throw new BoundaryError('write', path, [], WHY);
  }
}
