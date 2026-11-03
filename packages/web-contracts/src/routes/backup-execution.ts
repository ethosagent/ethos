import { oc } from '@orpc/contract';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Backup — local archives of `~/.ethos`, and the identity-only restore
// (plan/phases/agent-state-backup.md §5, D6)
//
// The pane is status-first, so `status` answers the whole header in one call:
// what the last backup was, when the next scheduled one runs, whether the
// schedule is on at all, which stores are in scope, and what archives are on
// disk. One round trip, one refresh after a create — the alternative was four
// procedures the pane would always call together.
//
// Bytes never travel over RPC. Download is a streaming, cookie-authenticated
// `GET /backup/download` — see `apps/web-api/src/routes/backup.ts`. The
// `downloadAvailable` flag below is how a Bearer caller (desktop remote mode)
// learns the route cannot serve it, instead of rendering a link that 401s.
//
// RESTORE IS `identity` ONLY (D6). A live server holds every database open, so
// a `state` restore cannot pass the core's in-use lock gate and is refused
// here — by the service, not by the absence of a button.
// ---------------------------------------------------------------------------

const BackupScopeSchema = z.enum(['identity', 'state', 'telemetry']);

/**
 * One archive file in the backup directory.
 *
 * There is deliberately no `scopes` field. The manifest that records them is
 * the LAST entry in the archive (plan D3), so reading it means decompressing
 * the whole thing — a listing of seven multi-hundred-megabyte archives is not
 * the place for that. `schedule.scopes` says what the configured scope set is;
 * a per-archive answer costs a full read and belongs to restore, which does
 * one anyway.
 */
const BackupArchiveSchema = z.object({
  /** Filename inside the backup directory. Feed it back as `?name=` on the
   *  download route and as `name` on `restoreIdentity`. */
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  /** ISO-8601, from the file's mtime. */
  createdAt: z.string(),
  /** True when the scheduled job wrote it (and rotation may delete it). */
  scheduled: z.boolean(),
});

/**
 * The header's anchor. `ok: false` means the most recent ATTEMPT failed — the
 * archive it would have written is absent, so `archive` is null and `error`
 * carries the reason. A success carries the archive and no error.
 */
const BackupLastRunSchema = z.object({
  ok: z.boolean(),
  /** ISO-8601 — when the attempt finished. */
  at: z.string(),
  archive: BackupArchiveSchema.nullable(),
  error: z.string().nullable(),
});

/**
 * `backup.*` in config.yaml, resolved. `enabled` is what makes the pane's
 * schedule toggle honest: a next run is only meaningful when the job exists.
 */
const BackupScheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string(),
  scopes: z.array(BackupScopeSchema),
  keep: z.number().int().positive(),
  /** From the `backup` system cron job. Null when the job is absent (schedule
   *  off) or this deployment runs no scheduler. */
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

/**
 * One row per known SQLite store (`WAL_STORES` in `@ethosagent/wiring`), which
 * is the drift-gated registry — a store added to the repo without a scope
 * decision fails CI, so this list cannot quietly go stale.
 */
const BackupStoreRowSchema = z.object({
  /** `~/.ethos`-relative database path, e.g. `sessions.db`. */
  database: z.string(),
  /** The scope that carries it, or null when it is deliberately excluded. */
  scope: BackupScopeSchema.nullable(),
  /** True when `scope` is non-null AND in the configured scope set. */
  included: z.boolean(),
  /** Why it sits in that scope, or why it is excluded. From the registry. */
  reason: z.string(),
  /**
   * Coarse, from mtimes — `changed` when the file is newer than the most
   * recent archive. `absent` when this deployment has never created the
   * database; `unknown` when there is no archive to compare against yet.
   */
  changed: z.enum(['changed', 'unchanged', 'absent', 'unknown']),
});

const BackupStatusOutput = z.object({
  /** Absolute path archives are written to (`backup.dir`, defaulted). */
  directory: z.string(),
  /**
   * ISO-8601 boot time of THIS server process. An identity restore rewrites
   * config.yaml / mcp.json, which are read at boot, so the pane pins its
   * "restart required" notice to the value it saw and clears it only when a
   * later status returns a different one. Nothing else can tell it the
   * restart actually happened.
   */
  serverStartedAt: z.string(),
  /** True while a web-triggered create is in flight in this process. */
  running: z.boolean(),
  /**
   * False when the caller authenticated with a Bearer API key. The download
   * route is cookie-only — an `<a download>` navigation carries the cookie but
   * cannot attach a header — so desktop remote mode must render the CLI
   * instructions instead of a link that would 401.
   */
  downloadAvailable: z.boolean(),
  schedule: BackupScheduleSchema,
  lastBackup: BackupLastRunSchema.nullable(),
  /** Newest first. */
  archives: z.array(BackupArchiveSchema),
  stores: z.array(BackupStoreRowSchema),
});

/** Omitted `scopes` uses the configured `backup.scope` (default identity+state). */
const BackupCreateInput = z.object({
  scopes: z.array(BackupScopeSchema).min(1).optional(),
});

const BackupCreateOutput = z.object({
  archive: BackupArchiveSchema,
  scopes: z.array(BackupScopeSchema),
  fileCount: z.number().int().nonnegative(),
  /** Uncompressed bytes archived — not the archive's own size. */
  uncompressedBytes: z.number().int().nonnegative(),
  /**
   * Files enumerated but not encodable as a tar entry, and databases no scope
   * rule accounts for. Both are reported rather than fatal, and both MUST be
   * surfaced — a silent drop is the failure mode a backup cannot have.
   */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  unclassifiedDatabases: z.array(z.string()),
});

/**
 * `scopes` exists so the refusal is a REFUSAL and not a schema error: asking
 * for `state` here returns FORBIDDEN naming why (D6), which the pane can
 * render, rather than a 400 the user cannot act on. Omitted means `identity`.
 */
const BackupRestoreIdentityInput = z.object({
  /** An archive `name` from `status.archives`. Single path segment; the route
   *  and the service both refuse anything else. */
  name: z.string().min(1),
  scopes: z.array(BackupScopeSchema).min(1).optional(),
  /** Report what would happen and change nothing. */
  dryRun: z.boolean().optional(),
});

const BackupRestoreOutput = z.object({
  dryRun: z.boolean(),
  scopes: z.array(BackupScopeSchema),
  /** When the archive was made, from its manifest. */
  createdAt: z.string(),
  /** `~/.ethos`-relative paths written (or, in a dry run, that would be). */
  restored: z.array(z.string()),
  /** Existing files moved aside first, and where they went. */
  displaced: z.array(z.string()),
  displacedTo: z.string().nullable(),
  /**
   * Whether the in-use lock gate RAN. `skipped_dry_run` / `skipped_force` mean
   * no check was made — `lockedDatabases` is then empty because nothing was
   * asked, NOT because nothing was running. The pane must never render an
   * empty list under those two as "nothing was running".
   */
  inUseCheck: z.enum(['held', 'skipped_dry_run', 'skipped_force']),
  lockedDatabases: z.array(z.string()),
  /** True when config.yaml or mcp.json was restored — both are read at boot. */
  restartRequired: z.boolean(),
  warnings: z.array(
    z.object({
      kind: z.enum(['fs_reach_absolute', 'skipped_path', 'unclassified_database']),
      path: z.string(),
      message: z.string(),
    }),
  ),
  /**
   * The archive's `secrets.manifest.yaml` verbatim, when it carries one. This
   * is OPERATOR INSTRUCTIONS written by whoever made the archive — untrusted
   * text. Render it as text, never as commands, and never execute it. It names
   * credentials; it never contains their values (the vault is excluded from
   * every scope).
   */
  secretsManifest: z.string().nullable(),
});

export type BackupScopeName = z.infer<typeof BackupScopeSchema>;
export type BackupArchive = z.infer<typeof BackupArchiveSchema>;
export type BackupLastRun = z.infer<typeof BackupLastRunSchema>;
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;
export type BackupStoreRow = z.infer<typeof BackupStoreRowSchema>;
export type BackupStatus = z.infer<typeof BackupStatusOutput>;
export type BackupCreateResult = z.infer<typeof BackupCreateOutput>;
export type BackupRestoreResult = z.infer<typeof BackupRestoreOutput>;

/** @experimental */
export const backup = {
  status: oc.output(BackupStatusOutput),
  create: oc.input(BackupCreateInput).output(BackupCreateOutput),
  restoreIdentity: oc.input(BackupRestoreIdentityInput).output(BackupRestoreOutput),
};

// ---------------------------------------------------------------------------
// Execution — the deployment's single remote target
// (plan/phases/remote-execution-routing.md §6, T7)
//
// One procedure, because the pane asks one question: can this machine reach the
// host that `execution: ssh` personalities run their terminal on, right now?
//
// UNCACHED, and that word is the whole contract. The backend keeps a 60 s
// success cache behind `isAvailable()` so a `run_code` invocation does not open
// a connection per call; a `Test connection` button that read that cache would
// answer about a moment the operator has already left — which is exactly the
// moment they pressed the button to get past. So the service calls `probe()`,
// which opens a real connection every time.
//
// `error` is the ssh client's own stderr, VERBATIM. `Permission denied
// (publickey)` and `Connection timed out` need completely different fixes and
// only the real line says which, so nothing here summarises, prettifies or
// re-words it. (ssh prints auth refusals without its `ssh:` prefix, so those
// arrive as a remote exit 255 rather than a transport error; `probe()` reports
// them the same way, and so does this.)
// ---------------------------------------------------------------------------

const ExecutionProbeStateSchema = z.discriminatedUnion('state', [
  /** No `execution.ssh.host`. NOT a failure — a fresh install has no target. */
  z.object({ state: z.literal('not_configured') }),
  z.object({
    state: z.literal('reachable'),
    /** `user@host:port`, as `formatSshTarget` renders it. */
    target: z.string(),
    /** Wall clock of the probe, milliseconds. */
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal('unreachable'),
    target: z.string(),
    /** The ssh client's stderr line, verbatim. */
    error: z.string(),
  }),
  /**
   * The backend could not be CONSTRUCTED — the boot failure of §6, seen from
   * the surface that asked. Distinct from `unreachable`: no connection was
   * attempted, so calling it unreachable would blame the network for a
   * deployment fault.
   */
  z.object({
    state: z.literal('backend_unresolved'),
    target: z.string(),
    error: z.string(),
  }),
  /**
   * `execution.ssh.*` was edited after this process booted, so the backend the
   * tools run on was built against a DIFFERENT target than config.yaml now
   * names. The execution-backend registry memoises: the instance survives the
   * edit, and nothing re-reads config until a restart.
   *
   * NEITHER host is contacted. Probing `activeTarget` would answer a question
   * about a host the operator has just stopped pointing at; probing `target`
   * would answer about a machine no tool will touch until a restart. Both are
   * false reassurance, so the state IS the answer — and it is not a failure of
   * either machine, which is why it carries no `error`.
   */
  z.object({
    state: z.literal('stale_config'),
    /** What `execution.ssh.*` names NOW. Not contacted. */
    target: z.string(),
    /**
     * What the running backend was constructed with — and therefore what every
     * `execution: ssh` personality's tools still execute on until a restart.
     * The operationally important half.
     */
    activeTarget: z.string(),
  }),
]);

const ExecutionProbeSshOutput = z.object({
  /**
   * Personality ids whose `execution` posture is `ssh` — the posture line under
   * the header (`ssh — used by: remote-hands`). Present in EVERY state,
   * including `not_configured`: a personality that declares a remote posture
   * with no host configured is the one case an operator most needs to see.
   */
  usedBy: z.array(z.string()),
  result: ExecutionProbeStateSchema,
});

export type ExecutionProbeResult = z.infer<typeof ExecutionProbeSshOutput>;
export type ExecutionProbeState = z.infer<typeof ExecutionProbeStateSchema>;

/** @experimental */
export const execution = {
  probeSsh: oc.output(ExecutionProbeSshOutput),
};
