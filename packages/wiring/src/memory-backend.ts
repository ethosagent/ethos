// Backend-aware memory assembly (memory-lifecycle vault gaps, plan §3a/§3b).
//
// One module decides, per configured backend, where the undecorated write
// provider lives, where its provenance history is rooted, and how the approval
// gate composes around it. Shared by:
//   - build-infrastructure — the runtime write path (the `markdown` and `vault`
//     registry factories compose the same history + pending-gate stack);
//   - build-agent-loop — proactive capture's undecorated base + history;
//   - createMemoryProviderFromConfig — nightly consolidation/decay and other
//     out-of-loop writers that must target the configured backend;
//   - createMemoryBundle — the editor / Timeline / restore / approve surfaces
//     a host hands the web API (F04, plan architecture-suggestions-2026-09-10),
//     built by build-agent-loop from the loop's own config.
//
// Placement decision (deliberate, §3b): memory CONTENT and its provenance
// history follow the backend — for a vault that means history JSONL + blobs
// under `<vaultRoot>/<agentDir>/.ethos-meta/` (dot-prefixed so Obsidian
// ignores it), written through the vault's ScopedStorage. The approval-gate
// machinery (pending queue + tombstones) is gate state, NOT memory content,
// and stays rooted at `~/.ethos` for every backend so `ethos memory pending`,
// the web pending RPCs, and capture's tombstone consultation work unchanged
// across backends.

import { join, resolve } from 'node:path';
import { LastWriteWinsPolicy, LazyOnDemandPolicy } from '@ethosagent/core';
import {
  type PendingGateObservability,
  PendingMemoryStore,
  TombstoneStore,
  withPendingGate,
} from '@ethosagent/memory-approval';
import { type HistorySource, HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VaultMemoryProvider } from '@ethosagent/memory-vault';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import {
  EthosError,
  type GlobalMemoryStore,
  type Logger,
  type MemoryContext,
  type MemoryProvider,
  type Storage,
} from '@ethosagent/types';

/** Subdir under the vault's agent root holding history JSONL + blobs (§3a). */
const VAULT_META_DIR = '.ethos-meta';

/** Subtree of the vault the agent owns, when `memoryVault.agentDir` is unset. */
const DEFAULT_AGENT_DIR = 'Ethos';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The config slice that selects a memory backend. Both `EthosConfig` and
 *  `WiringConfig` satisfy this structurally. */
export interface MemoryBackendSelection {
  memory?: 'markdown' | 'vector' | 'vault';
  memoryVault?: {
    path?: string;
    agentDir?: string;
    prefetch?: string[];
    exclude?: string[];
  };
  /** Per-key markdown ceilings, in characters. Absent → 512K per key. */
  memoryCharLimits?: { memory?: number; user?: number };
  /**
   * Approve-before-store gate tuning (`memoryApproval.*`). Not backend
   * selection, but the same config slice: the runtime gate
   * (`composeGatedMemory`) and every out-of-loop queue
   * (`createPendingMemoryStore`) read cap + TTL from here, so the web/CLI queue
   * prunes and caps exactly as the gate that fills it.
   */
  memoryApproval?: { mode?: 'off' | 'automated' | 'all'; cap?: number; ttlDays?: number };
  /**
   * `memoryCapture.evidenceSessions` — read by `createPendingMemoryStore` so the
   * CLI and web queues order by recurrence evidence the way capture's own
   * queue (`build-agent-loop`) does.
   */
  memoryCapture?: { evidenceSessions?: number };
}

/**
 * Why the configured backend has no file-style memory surface (MEMORY.md /
 * USER.md read + edit, archive restore, lifecycle ops, provenance history), or
 * `null` when it has one. `markdown` and `vault` do — the same two backends
 * proactive capture and the approval gate compose over (`build-infrastructure`,
 * `build-agent-loop`). `vector` does not: the agent reads its memory from
 * `memory.db`, so a file surface would edit bytes the agent never reads. The
 * one predicate behind the web editor's refusal (`createMemoryBundle`), the
 * CLI's (`apps/ethos/src/lib/file-memory.ts`) and approve's
 * (`createPendingMemoryStore`).
 */
export function fileMemoryUnsupportedReason(selection: MemoryBackendSelection): string | null {
  const backend = selection.memory ?? 'markdown';
  if (backend === 'markdown' || backend === 'vault') return null;
  return `The "${backend}" memory backend has no file editor: the agent reads its memory from that backend, not from MEMORY.md / USER.md files.`;
}

/**
 * Where a `memory: vault` deployment's content and provenance live, or `null`
 * when the selection is not a vault (or names no path — `buildVaultBackend`
 * refuses that at boot). The one place the layout `buildVaultBackend` builds is
 * readable from without opening a provider; the backup surfaces use it to name
 * what an archive cannot carry (`backup/external-memory.ts`).
 */
export function vaultMemoryRoots(
  selection: MemoryBackendSelection,
): { agentRoot: string; metaRoot: string } | null {
  if (selection.memory !== 'vault') return null;
  const path = selection.memoryVault?.path;
  if (!path) return null;
  const agentRoot = join(resolve(path), selection.memoryVault?.agentDir ?? DEFAULT_AGENT_DIR);
  return { agentRoot, metaRoot: join(agentRoot, VAULT_META_DIR) };
}

/**
 * Team-topic memory for one team, with the policy stack every writer must share
 * (plan architecture-suggestions-2026-09-10, F04 follow-up): `LazyOnDemandPolicy`
 * keeps the topics out of the prompt preamble, `LastWriteWinsPolicy` makes a
 * write carry an mtime precondition so it cannot silently overwrite another
 * writer's. Team memory is markdown under `<teamsDir>/<team>/memory` for every
 * backend — team topics are not one agent's personality content, and the vault
 * holds exactly that (module docstring).
 *
 * ONE INSTANCE PER CALLER, by `LastWriteWinsPolicy`'s contract: the precondition
 * map is keyed by scope+key and belongs to whoever read the entry, so the agent
 * loop and the web editor each hold their own — sharing one would let each
 * other's reads clear the other's precondition. Callers keep the instance for as
 * long as they serve that team (web-api's `TeamsService` memoises per team);
 * building a fresh one per request would drop the precondition entirely.
 */
export function createTeamMemoryProvider(opts: {
  /** The directory holding `<team>/memory` — `<dataDir>/teams` in production. */
  teamsDir: string;
  teamName: string;
  storage: Storage;
}): MemoryProvider {
  return new LazyOnDemandPolicy(
    new LastWriteWinsPolicy(
      new MarkdownFileMemoryProvider({
        dir: join(opts.teamsDir, opts.teamName, 'memory'),
        storage: opts.storage,
      }),
    ),
  );
}

/**
 * Cap + TTL for a pending queue, from `memoryApproval`. The ONE derivation:
 * `composeGatedMemory` (the runtime gate), `createPendingMemoryStore` (the CLI
 * and web queues, and `createMemoryBundle`'s) and proactive capture's own queue
 * in `build-agent-loop` all read it here, so every queue over one deployment
 * caps and expires alike.
 */
export function approvalLimits(approval: MemoryBackendSelection['memoryApproval']): {
  cap?: number;
  ttlMs?: number;
} {
  return {
    ...(approval?.cap !== undefined ? { cap: approval.cap } : {}),
    ...(approval?.ttlDays !== undefined ? { ttlMs: approval.ttlDays * DAY_MS } : {}),
  };
}

export interface UndecoratedBackend {
  /** Undecorated write provider for the configured backend. */
  base: MemoryProvider & GlobalMemoryStore;
  /** Provenance history rooted with the backend's content. */
  history: HistoryStore;
  /**
   * Root under which per-scope memory files and the `memory-meta.json`
   * sidecar resolve (`<memoryRoot>/personalities/<id>/…`). The vault mirrors
   * the markdown layout under `<vaultRoot>/<agentDir>`.
   */
  memoryRoot: string;
  /** Storage handle confined appropriately for sidecar I/O under memoryRoot. */
  storage: Storage;
}

export interface VaultBackend extends UndecoratedBackend {
  base: VaultMemoryProvider;
}

/**
 * Construct the undecorated vault provider plus its ScopedStorage confinement
 * (read the whole vault so search can find the user's notes; write only inside
 * the agent's own subtree — the sensitive-path floor applies beneath both) and
 * its `.ethos-meta` history store.
 */
export function buildVaultBackend(opts: {
  vault: MemoryBackendSelection['memoryVault'];
  storage: Storage;
  logger?: Logger;
}): VaultBackend {
  const vault = opts.vault;
  if (!vault?.path) {
    throw new Error('memory: vault requires memoryVault.path to be set in config.');
  }
  const vaultRoot = resolve(vault.path);
  const agentDir = vault.agentDir ?? DEFAULT_AGENT_DIR;
  const agentRoot = join(vaultRoot, agentDir);
  const scoped = new ScopedStorage(opts.storage, {
    read: [`${vaultRoot}/`],
    write: [`${agentRoot}/`],
    alwaysDeny: defaultAlwaysDeny(),
  });
  const base = new VaultMemoryProvider({
    vaultRoot,
    agentDir,
    storage: scoped,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(vault.prefetch && vault.prefetch.length > 0 ? { prefetchKeys: vault.prefetch } : {}),
    ...(vault.exclude && vault.exclude.length > 0 ? { exclude: vault.exclude } : {}),
  });
  const metaDir = join(agentRoot, VAULT_META_DIR);
  const history = new HistoryStore({ dataDir: metaDir, storage: scoped });
  return { base, history, memoryRoot: agentRoot, storage: scoped };
}

/**
 * Resolve the undecorated provider + history for the configured backend.
 * `markdown` (and, for out-of-loop writers, `vector` — nightly consolidation
 * has always operated on the markdown store beside the vector index) root at
 * `dataDir`; `vault` roots at `<vaultRoot>/<agentDir>` with `.ethos-meta`
 * history.
 */
export function createUndecoratedBackend(opts: {
  selection: MemoryBackendSelection;
  dataDir: string;
  storage: Storage;
  logger?: Logger;
}): UndecoratedBackend {
  if (opts.selection.memory === 'vault') {
    return buildVaultBackend({
      vault: opts.selection.memoryVault,
      storage: opts.storage,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }
  const base = new MarkdownFileMemoryProvider({
    dir: opts.dataDir,
    storage: opts.storage,
    ...(opts.selection.memoryCharLimits ? { charLimits: opts.selection.memoryCharLimits } : {}),
  });
  const history = new HistoryStore({ dataDir: opts.dataDir, storage: opts.storage });
  return { base, history, memoryRoot: opts.dataDir, storage: opts.storage };
}

export interface ComposeGatedMemoryOptions {
  base: MemoryProvider & GlobalMemoryStore;
  /** The backend's own history store (vault: `.ethos-meta`; markdown: dataDir). */
  history: HistoryStore;
  approval?: { mode?: 'off' | 'automated' | 'all'; cap?: number; ttlDays?: number };
  /** Gate-machinery root — ALWAYS `~/.ethos` (see module docstring). */
  dataDir: string;
  /** Gate-machinery storage — the raw wiring storage, never the vault scope. */
  storage: Storage;
  observability?: PendingGateObservability;
}

export interface GatedMemoryStack {
  /** The agent-facing write handle (history + gate composed). */
  provider: MemoryProvider & GlobalMemoryStore;
  /** The pending queue — present only when the gate is on. */
  pending?: PendingMemoryStore;
}

/**
 * Compose the agent-facing write stack around an undecorated backend: the M1
 * history decorator plus (when enabled) the L2 approve-before-store gate.
 *
 * Compose HISTORY OUTSIDE GATE: a gated write parks in the pending queue and
 * touches no bytes, so the outer history sees before === after and records
 * nothing; a non-gated write flows through to the provider and is recorded
 * once. Approve replays through `apply` (a fresh history handle carrying the
 * ORIGINAL source + approvedBy) against the BACKEND provider, so an approved
 * candidate is recorded exactly once, on apply, in the backend's history.
 */
export function composeGatedMemory(opts: ComposeGatedMemoryOptions): GatedMemoryStack {
  const approvalMode = opts.approval?.mode ?? 'off';
  if (approvalMode === 'off') {
    return { provider: withHistory(opts.base, opts.history, { source: 'tool' }) };
  }
  const tombstones = new TombstoneStore({ storage: opts.storage, dataDir: opts.dataDir });
  const pending = new PendingMemoryStore({
    storage: opts.storage,
    dataDir: opts.dataDir,
    tombstones,
    ...approvalLimits(opts.approval),
    ...(opts.observability ? { observability: opts.observability } : {}),
    apply: async (entry, approvedBy) => {
      const handle = withHistory(opts.base, opts.history, { source: entry.source, approvedBy });
      const ctx: MemoryContext = {
        scopeId: entry.scopeId,
        sessionId: entry.sessionId ?? '',
        sessionKey: entry.sessionKey ?? 'cli',
        platform: 'cli',
        workingDir: '',
      };
      await handle.sync([entry.update], ctx);
    },
  });
  const gate = withPendingGate(opts.base, { store: pending, mode: approvalMode, source: 'tool' });
  return { provider: withHistory(gate, opts.history, { source: 'tool' }), pending };
}

export interface CreateMemoryProviderFromConfigOptions {
  /** Backend selection — pass the app config (`EthosConfig` / `WiringConfig`). */
  config: MemoryBackendSelection;
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /** Provenance-history source label baked into the returned handle. */
  source?: HistorySource;
  logger?: Logger;
}

export interface ConfiguredMemoryBackend {
  /** History-decorated write handle targeting the configured backend. */
  provider: MemoryProvider & GlobalMemoryStore;
  /** The backend's history store (for rotate / direct records). */
  history: HistoryStore;
  /** Root for per-scope memory files + `memory-meta.json` sidecars. */
  memoryRoot: string;
  /** Storage handle for sidecar I/O under `memoryRoot`. */
  storage: Storage;
}

/**
 * Returns a history-decorated handle for the CONFIGURED backend (`memory:
 * vault` → the vault, everything else → markdown at dataDir), plus the pieces
 * out-of-loop writers need — the history store for rotation and the sidecar
 * root/storage. Used by the nightly pass so consolidation/decay target the
 * same store the agent reads from, and by the CLI/Slack file-memory surfaces
 * (`apps/ethos/src/lib/file-memory.ts`, which first refuses a backend with no
 * file memory via `fileMemoryUnsupportedReason` — this function itself maps
 * `vector` to markdown at dataDir, the store nightly has always consolidated).
 */
export function createMemoryProviderFromConfig(
  opts: CreateMemoryProviderFromConfigOptions,
): ConfiguredMemoryBackend {
  const backend = createUndecoratedBackend({
    selection: opts.config,
    dataDir: opts.dataDir,
    storage: opts.storage,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return {
    provider: withHistory(backend.base, backend.history, { source: opts.source ?? 'tool' }),
    history: backend.history,
    memoryRoot: backend.memoryRoot,
    storage: backend.storage,
  };
}

export interface CreatePendingMemoryStoreOptions {
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  storage: Storage;
  /**
   * Memory config slice (`memory` / `memoryVault` / `memoryApproval`). With
   * `memory: 'vault'`, approve replays through the vault provider with
   * provenance history under `<vaultRoot>/<agentDir>/.ethos-meta`; with a
   * backend that has no file memory (`vector`) approve is refused (see
   * `createPendingMemoryStore`). The pending queue + tombstones stay at
   * `dataDir` regardless of backend. Cap + TTL come from `memoryApproval`,
   * as the runtime gate's do. Omitted → markdown at `dataDir`, default limits.
   */
  config?: MemoryBackendSelection;
  /** Per-scope queue hard cap. Overrides `config.memoryApproval.cap`; default 200. */
  cap?: number;
  /** Pending candidate TTL in ms. Overrides `config.memoryApproval.ttlDays`; default 30 days. */
  ttlMs?: number;
  observability?: PendingGateObservability;
  /** Test seam. */
  now?: () => number;
}

/**
 * Assemble a `PendingMemoryStore` (memory-lifecycle L2) over the configured
 * backend, with the approve-replay `apply` wired to the provenance history so an
 * approved candidate records under its ORIGINAL source plus `approvedBy`. Used
 * by the CLI `ethos memory pending` command and (L3, via `createMemoryBundle`)
 * the web RPC service — the runtime write path composes the gate inline in
 * `build-infrastructure`.
 *
 * Approve matches the runtime: the gate composes only over `markdown` and
 * `vault` (`build-infrastructure`'s registry factories), so under any other
 * backend (`vector`) nothing in the running agent ever parks or replays a
 * candidate. A candidate still in the queue there was parked under an earlier
 * backend, and approving it throws NOT_CONFIGURED rather than replaying into a
 * markdown store the agent does not read. The entry stays queued (`approve`
 * removes it only after `apply` resolves); reject still works.
 */
export function createPendingMemoryStore(opts: CreatePendingMemoryStoreOptions): {
  store: PendingMemoryStore;
  tombstones: TombstoneStore;
} {
  const selection = opts.config ?? {};
  const unsupported = fileMemoryUnsupportedReason(selection);
  const backend = unsupported
    ? null
    : createUndecoratedBackend({ selection, dataDir: opts.dataDir, storage: opts.storage });
  const tombstones = new TombstoneStore({ storage: opts.storage, dataDir: opts.dataDir });
  const store = new PendingMemoryStore({
    storage: opts.storage,
    dataDir: opts.dataDir,
    tombstones,
    ...approvalLimits(selection.memoryApproval),
    // Ordering only: this store never auto-promotes. Capture's own queue does
    // (`build-agent-loop`), and it is the only writer that proposes.
    ...(selection.memoryCapture?.evidenceSessions
      ? { evidenceSessions: selection.memoryCapture.evidenceSessions }
      : {}),
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    apply: async (entry, approvedBy) => {
      if (!backend) {
        throw new EthosError({
          code: 'NOT_CONFIGURED',
          cause: `Cannot approve into the "${selection.memory}" memory backend: it has no approval gate, so this candidate was queued under an earlier backend and the agent would never read it back.`,
          action: 'Reject it, or switch `memory:` back to markdown or vault to approve it.',
        });
      }
      const { base, history } = backend;
      const handle = withHistory(base, history, {
        source: entry.source,
        approvedBy,
        // Same as capture's own apply (`build-agent-loop`): an evidence entry
        // records its hash so dedup does not queue the approved fact again.
        ...(entry.evidenceSessions && entry.factHash ? { captureHashes: [entry.factHash] } : {}),
      });
      const ctx: MemoryContext = {
        scopeId: entry.scopeId,
        sessionId: entry.sessionId ?? '',
        sessionKey: entry.sessionKey ?? 'cli',
        platform: 'cli',
        workingDir: '',
      };
      await handle.sync([entry.update], ctx);
    },
  });
  return { store, tombstones };
}

/** File-style editing over the configured backend: MEMORY.md / USER.md read +
 *  replace, the provenance Timeline, and archive restore. */
export interface MemoryEditing {
  supported: true;
  /** `web-editor`-labelled handle — every editor write records under that source. */
  editor: MemoryProvider & GlobalMemoryStore;
  /** `restore`-labelled handle — an archive restore records itself (§5). */
  restore: MemoryProvider & GlobalMemoryStore;
  /** The backend's own history (vault: `.ethos-meta`; markdown: dataDir). */
  history: HistoryStore;
}

/** The configured backend has no file-style editing surface. */
export interface MemoryEditingUnsupported {
  supported: false;
  /** Why — surfaced verbatim by the editor's refusal. */
  reason: string;
}

/**
 * The memory surfaces a host exposes OUTSIDE the agent loop (F04): the web /
 * desktop editor, the Timeline, restore, and the approve-before-store queue.
 * Built by `createMemoryBundle` from the same config slice the loop's memory
 * registry resolves (`buildAgentLoop` builds both from one `config` — pinned by
 * `__tests__/memory-bundle-loop.test.ts`), so the editor writes where the agent
 * reads. The pieces are matched, not shared:
 * each handle is its own decorator over the backend with its own source label.
 */
export interface MemoryBundle {
  /** The configured backend (`config.memory ?? 'markdown'`). */
  backend: NonNullable<MemoryBackendSelection['memory']>;
  editing: MemoryEditing | MemoryEditingUnsupported;
  /**
   * Approve-before-store queue. Gate state, not memory content: the queue and
   * tombstones stay at `dataDir` for every backend (module docstring); approve
   * replays into the configured backend via `createPendingMemoryStore`.
   */
  pending: PendingMemoryStore;
  /**
   * Team-topic memory for one team (`createTeamMemoryProvider`), so web-api's
   * `TeamsService` borrows the stack the `team_memory_*` tools write through
   * instead of building a bare provider over the same directory. Call once per
   * team and keep it — the write precondition lives on the instance.
   */
  teamMemory: (teamName: string) => MemoryProvider;
}

export interface CreateMemoryBundleOptions {
  /** Backend selection — the SAME config the agent loop is built from. */
  config: MemoryBackendSelection;
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /** The wiring storage the loop's memory registry uses. */
  storage: Storage;
  logger?: Logger;
}

/**
 * Build the host-side memory surfaces for the configured backend (F04).
 *
 * `markdown` and `vault` support file-style editing (`fileMemoryUnsupportedReason`).
 * Anything else (`vector`: the agent reads entries out of `memory.db`) gets an
 * explicit refusal instead of a markdown editor at `dataDir` that edits bytes
 * the agent never reads. The approve queue takes cap + TTL from
 * `config.memoryApproval` and refuses approve under such a backend
 * (`createPendingMemoryStore`).
 */
export function createMemoryBundle(opts: CreateMemoryBundleOptions): MemoryBundle {
  const backend = opts.config.memory ?? 'markdown';
  // Cap + TTL from `config.memoryApproval`, as the runtime gate's.
  const { store: pending } = createPendingMemoryStore({
    dataDir: opts.dataDir,
    storage: opts.storage,
    config: opts.config,
  });
  const teamMemory = (teamName: string): MemoryProvider =>
    createTeamMemoryProvider({
      teamsDir: join(opts.dataDir, 'teams'),
      teamName,
      storage: opts.storage,
    });
  const unsupported = fileMemoryUnsupportedReason(opts.config);
  if (unsupported) {
    return { backend, editing: { supported: false, reason: unsupported }, pending, teamMemory };
  }
  const { base, history } = createUndecoratedBackend({
    selection: opts.config,
    dataDir: opts.dataDir,
    storage: opts.storage,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return {
    backend,
    editing: {
      supported: true,
      editor: withHistory(base, history, { source: 'web-editor' }),
      restore: withHistory(base, history, { source: 'restore' }),
      history,
    },
    pending,
    teamMemory,
  };
}
