// Governed self-amendment — a personality's request to change its own
// definition (plan personality-memory-boundary-and-self-amendment, G2).
//
// Types only. They live here, not in `@ethosagent/learning-inbox` (the store,
// `amendment-store.ts`), so web-contracts can build schemas without importing
// an extension. An amendment is NOT a `LearningCandidate`: it has its own
// directory (`learning/amendments/`, `amendmentsDir` in
// extensions/learning-inbox/src/paths.ts) that no candidate path reads, so no
// automatic promotion path can see it (G2-1). Pinned by the amendment cases
// in extensions/learning-inbox/src/__tests__/store.test.ts,
// auto-promotion.test.ts and promote.test.ts.

import type { TurnAudience, TurnInitiator } from './audience';
import type { ExecutionPosture } from './execution';
import type { ToolContext } from './tool';

/**
 * One change to a personality's `toolset.yaml`. v1 is toolset membership only
 * (D24); `fs_reach` prefix ops are v1.1.
 */
export interface AmendmentOp {
  op: 'add_tool' | 'remove_tool';
  tool: string;
}

/** What an amendment changes. v1: `toolset.yaml` only. */
export type AmendmentTarget = 'toolset';

/**
 * - `pending` — filed, waiting on the owner.
 * - `applied` — the owner applied it; `applied` carries the written hash.
 * - `declined` — the owner declined it (a `stale` one included).
 * - `auto_rejected` — the constitution forbade the after-state, at filing or
 *   at apply.
 * - `stale` — the live file no longer matches `baseHash`, or an op no longer
 *   applies. Closed by `declined`, or — crash recovery only, when an earlier
 *   apply is proven to have written the live bytes — by `applied`.
 * - `rolled_back` — an applied amendment whose prior bytes were restored.
 */
export type AmendmentStatus =
  | 'pending'
  | 'applied'
  | 'declined'
  | 'auto_rejected'
  | 'stale'
  | 'rolled_back';

/**
 * Review flags. Never stored: recomputed on every read, because each depends
 * on live state (the registry, the execution posture) rather than on the
 * filing. `team-workflow` is the permission diff's flag for removing a kanban
 * closer tool (`KANBAN_CLOSER_TOOLS`, extensions/personalities/src/
 * permission-surface.ts). Computed by `amendmentFlags`
 * (packages/wiring/src/amendments.ts).
 */
export type AmendmentFlag =
  | 'tool-unavailable'
  | 'no-recorded-refusal'
  | 'local-terminal'
  | 'high-risk'
  | 'team-workflow';

/** A refused tool call in the filing session the personality cites (optional, D26). */
export interface AmendmentEvidence {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
  /** Capped and redacted by the intake. Untrusted text. */
  excerpt: string;
}

/** Where and how the amendment was filed. Recorded, never re-derived. */
export interface AmendmentProvenance {
  sessionId: string;
  sessionKey: string;
  platform: string;
  /** `ToolContext.origin`, when the turn had one. */
  origin?: string;
  /** `ToolContext.initiator` at filing; the intake files only for `'user'`. */
  initiator: TurnInitiator;
  /** `ToolContext.roomAudience` at filing; the intake files only for `'private'`. */
  roomAudience: TurnAudience;
  /** The turn's index in its session, when the host knows it. */
  turn?: number;
  traceId?: string;
  /** The resolved execution backend at filing (`ExecutionPosture.backend`). */
  executionPosture: ExecutionPosture['backend'];
  /** Whether the personality held a shell tool at filing (the `local-terminal` flag). */
  holdsShellTool: boolean;
}

/** The constitution check at filing: `'ok'`, or the violation it reported. */
export type AmendmentPreCheck = 'ok' | { reason: string };

/**
 * Who recorded a history entry: the filing intake, or a human surface. The
 * web surface is read-only in v1 (D30); `'web'` is reserved for v1.1.
 */
export type AmendmentActor = 'intake' | 'cli' | 'web';

/** One entry in the record's decision history (D29). */
export interface AmendmentHistoryEntry {
  action: 'filed' | 'auto_reject' | 'approve' | 'decline' | 'stale' | 'rollback';
  actor: AmendmentActor;
  /** The person who decided, for a human action. */
  decidedBy?: string;
  /** ISO 8601. */
  at: string;
  reason?: string;
}

/**
 * The stored proposal, `learning/amendments/<id>/proposal.json`.
 *
 * Hashes are sha256, lowercase hex, over UTF-8 text — the same function as
 * `hashDefinitionBytes` (extensions/personalities/src/index.ts), so a
 * `baseHash` recorded here is the `expectedHash` `writeDefinitionBytes`
 * compares against.
 */
export interface AmendmentRecord {
  schemaVersion: 1;
  /** `a-<ts36>-<rand>`, `assertSafeId`-clean. */
  id: string;
  /** The filing personality — the only personality it can ever change (G2-2). */
  personalityId: string;
  target: AmendmentTarget;
  /** Canonical: deduplicated, sorted by tool then op, no add+remove of one tool. */
  ops: AmendmentOp[];
  /** sha256 of `JSON.stringify(ops)` over the canonical ops. */
  opsHash: string;
  /**
   * sha256 of the live `toolset.yaml` at filing. Never null: a missing or
   * empty `toolset.yaml` is an UNDECLARED toolset, which cannot opt in to
   * filing, and `applyOps` refuses it — so there is no "no file" base. That is
   * consistent with `writeDefinitionBytes`, whose compare-and-swap treats a
   * missing file as a mismatch for every hash.
   */
  baseHash: string;
  /** ≤ 1000 chars. Untrusted text: rendered escaped, never put in a prompt. */
  rationale: string;
  evidence: AmendmentEvidence[];
  provenance: AmendmentProvenance;
  preCheck: AmendmentPreCheck;
  status: AmendmentStatus;
  /** Oldest first. The first entry is `filed` or `auto_reject`. */
  history: AmendmentHistoryEntry[];
  /** Set when applied: the hash of the bytes written, and when. */
  applied?: { appliedHash: string; at: string };
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/** What the `propose_self_amendment` tool passes to its port. */
export interface AmendmentSubmitInput {
  ops: AmendmentOp[];
  rationale: string;
  /** Tool-call ids of refused calls in the current session. */
  evidenceToolCallIds?: string[];
}

/** The port's answer. `ok: false` writes nothing. */
export type AmendmentSubmitResult =
  | {
      ok: true;
      id: string;
      status: 'pending' | 'auto_rejected';
      /** True when an identical pending amendment already existed and its id is returned. */
      deduped: boolean;
      /** The constitution's reason, for `auto_rejected`. */
      reason?: string;
    }
  | { ok: false; reason: string };

/**
 * The environment variable a tool-spawned host process carries (`'1'`), and
 * that `ethos personality amendments apply|rollback` refuses to run under
 * (D32). Set by the host paths of `terminal` (extensions/tools-terminal),
 * `process_start` (`spawnDetached`, extensions/tools-process/src/spawn.ts)
 * and the code tools' command runners (extensions/tools-code — `run_code`
 * itself never runs on the host, so it has no host path to set it on); read
 * by `assertNotToolProcess` (apps/ethos/src/commands/personality-amendments.ts).
 *
 * A TRIPWIRE, NOT A BOUNDARY: `env -u ETHOS_TOOL_PROCESS` defeats it. It
 * catches a personality holding a shell tool under local execution that runs
 * the CLI plainly; such a personality can already edit its own definition
 * files (G2-1's exception). Routed backends are not given it: ssh cannot
 * deliver env (`SshEnvUnsupportedError`), and a Docker container has no Ethos
 * CLI to run. It is not blind, though: when its reach spans the state
 * directory, `learning/` is mounted read-only (`DockerExecutionBackend.
 * mountsFor`, extensions/execution-docker/src/index.ts), so it can read filed
 * requests but cannot write one or apply one.
 */
export const TOOL_PROCESS_ENV_VAR = 'ETHOS_TOOL_PROCESS';

/**
 * The only thing the `propose_self_amendment` tool holds: it can FILE, never
 * apply (G2-1 (b)). Implemented by the intake in wiring.
 */
export interface AmendmentSubmitPort {
  submit(input: AmendmentSubmitInput, ctx: ToolContext): Promise<AmendmentSubmitResult>;
}
