// The self-amendment store (plan personality-memory-boundary G2, D28).
//
// One directory per amendment under `learning/amendments/` — a sibling of
// `candidates/`, so nothing that reads candidates (listing, replay,
// auto-promotion, `promote`) can see one (G2-1 (a)). Files through `Storage`,
// every write `writeAtomic`, the same posture as `store.ts` (L-D10).
//
// Check-then-write is not atomic across processes on its own. The pending
// limit and the dedupe (`checkPendingLimits`, re-run inside
// `createAmendment`) and every transition are meant to run under
// `amendmentApplyLockPath`. This package cannot take that lock itself
// (`acquireSentinelLock` lives in `packages/wiring`); its callers there take
// it: the filing intake (`createAmendmentIntake`, packages/wiring/src/
// amendments.ts, via `acquireAmendmentLock`) and the review service
// (`createAmendmentService`, same file).

import type {
  AmendmentActor,
  AmendmentEvidence,
  AmendmentHistoryEntry,
  AmendmentOp,
  AmendmentPreCheck,
  AmendmentProvenance,
  AmendmentRecord,
  AmendmentStatus,
  Storage,
} from '@ethosagent/types';
import { canonicalizeOps, opsHash } from './amendment-ops';
import { amendmentDir, amendmentProposalPath, amendmentsDir } from './paths';

/** At most this many `pending` amendments per personality. */
export const MAX_PENDING_AMENDMENTS = 3;

/** The rationale bound the tool also enforces. */
export const MAX_AMENDMENT_RATIONALE = 1000;

/** Sortable, lowercase, `assertSafeId`-clean. */
export function newAmendmentId(now: () => number = Date.now): string {
  const stamp = now().toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `a-${stamp}-${suffix}`;
}

const STATUSES: ReadonlySet<string> = new Set<AmendmentStatus>([
  'pending',
  'applied',
  'declined',
  'auto_rejected',
  'stale',
  'rolled_back',
]);

/** One stored op: `{ op: 'add_tool' | 'remove_tool', tool: string }`, nothing looser. */
function isOpShape(value: unknown): value is AmendmentOp {
  if (!value || typeof value !== 'object') return false;
  const { op, tool } = value as Record<string, unknown>;
  return (op === 'add_tool' || op === 'remove_tool') && typeof tool === 'string';
}

/**
 * Null for a missing, unparseable or foreign-shaped record — a broken file must
 * not stop a listing. The ops are re-validated on every read (shape, then
 * `canonicalizeOps`), so a hand-edited `proposal.json` cannot hand apply or
 * rollback an op no filing could have produced. Pinned by the forged-record
 * cases in extensions/learning-inbox/src/__tests__/amendment-store.test.ts.
 */
export async function readAmendment(
  storage: Storage,
  dataDir: string,
  amendmentId: string,
): Promise<AmendmentRecord | null> {
  const raw = await storage.read(amendmentProposalPath(dataDir, amendmentId));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Partial<AmendmentRecord>;
  if (
    r.schemaVersion !== 1 ||
    r.id !== amendmentId ||
    typeof r.personalityId !== 'string' ||
    r.target !== 'toolset' ||
    !Array.isArray(r.ops) ||
    !r.ops.every(isOpShape) ||
    !canonicalizeOps(r.ops).ok ||
    typeof r.opsHash !== 'string' ||
    typeof r.baseHash !== 'string' ||
    typeof r.status !== 'string' ||
    !STATUSES.has(r.status) ||
    !Array.isArray(r.history)
  ) {
    return null;
  }
  return r as AmendmentRecord;
}

export interface AmendmentFilter {
  personalityId?: string;
  status?: AmendmentStatus | readonly AmendmentStatus[];
}

/** Every readable amendment, newest first. Files beside the directories (`.apply.lock`) are skipped. */
export async function listAmendments(
  storage: Storage,
  dataDir: string,
  filter?: AmendmentFilter,
): Promise<AmendmentRecord[]> {
  const entries = await storage.listEntries(amendmentsDir(dataDir));
  const out: AmendmentRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    let record: AmendmentRecord | null;
    try {
      record = await readAmendment(storage, dataDir, entry.name);
    } catch {
      // An unsafe directory name (`assertSafeId`) is not an amendment.
      continue;
    }
    if (!record) continue;
    if (filter?.personalityId && record.personalityId !== filter.personalityId) continue;
    if (filter?.status) {
      const wanted = typeof filter.status === 'string' ? [filter.status] : filter.status;
      if (!wanted.includes(record.status)) continue;
    }
    out.push(record);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export type PendingLimitCheck =
  | { kind: 'ok' }
  /** A pending amendment with the same canonical ops exists; its id is the answer. */
  | { kind: 'duplicate'; existing: AmendmentRecord }
  /** The personality already has {@link MAX_PENDING_AMENDMENTS} pending. */
  | { kind: 'limit'; pending: number };

/**
 * The filing limits: the same `opsHash` as a pending amendment of the same
 * personality returns that one, and a personality may hold at most
 * {@link MAX_PENDING_AMENDMENTS} pending. Dedupe is checked first, so
 * re-filing an existing request at the limit still answers with its id.
 * Callers hold `amendmentApplyLockPath`.
 */
export async function checkPendingLimits(
  storage: Storage,
  dataDir: string,
  personalityId: string,
  hashOfOps: string,
): Promise<PendingLimitCheck> {
  const pending = await listAmendments(storage, dataDir, { personalityId, status: 'pending' });
  const existing = pending.find((record) => record.opsHash === hashOfOps);
  if (existing) return { kind: 'duplicate', existing };
  if (pending.length >= MAX_PENDING_AMENDMENTS) return { kind: 'limit', pending: pending.length };
  return { kind: 'ok' };
}

export interface CreateAmendmentInput {
  personalityId: string;
  /** Raw ops; canonicalised here, so a record's `ops`/`opsHash` are canonical by construction. */
  ops: readonly AmendmentOp[];
  baseHash: string;
  rationale: string;
  evidence: readonly AmendmentEvidence[];
  provenance: AmendmentProvenance;
  preCheck: AmendmentPreCheck;
  /** `pending`, or `auto_rejected` when the constitution forbade the after-state. */
  status: 'pending' | 'auto_rejected';
  /** Forced id, for tests. */
  id?: string;
}

export type CreateAmendmentResult =
  | { kind: 'created'; record: AmendmentRecord }
  | { kind: 'duplicate'; record: AmendmentRecord }
  | { kind: 'limit'; pending: number };

/**
 * Write a new amendment. A `pending` one re-runs {@link checkPendingLimits}
 * first, so the limit and the dedupe hold even for a caller that skipped the
 * check; an `auto_rejected` one is a record of a refusal and counts against
 * neither. Throws on input no filing path should produce (ops that do not
 * canonicalise, an over-long rationale, a pre-check that contradicts the
 * status, an existing id) — the intake refuses those earlier with a reason.
 */
export async function createAmendment(
  storage: Storage,
  dataDir: string,
  input: CreateAmendmentInput,
  now: () => number = Date.now,
): Promise<CreateAmendmentResult> {
  const canonical = canonicalizeOps(input.ops);
  if (!canonical.ok) throw new Error(`Amendment ops refused: ${canonical.reason}`);
  if (input.rationale.length > MAX_AMENDMENT_RATIONALE) {
    throw new Error(`Amendment rationale exceeds ${MAX_AMENDMENT_RATIONALE} characters`);
  }
  if ((input.status === 'pending') !== (input.preCheck === 'ok')) {
    throw new Error('Amendment status must be pending exactly when the pre-check is ok');
  }
  const hashOfOps = opsHash(canonical.ops);

  if (input.status === 'pending') {
    const check = await checkPendingLimits(storage, dataDir, input.personalityId, hashOfOps);
    if (check.kind === 'duplicate') return { kind: 'duplicate', record: check.existing };
    if (check.kind === 'limit') return check;
  }

  const id = input.id ?? newAmendmentId(now);
  if (await storage.exists(amendmentProposalPath(dataDir, id))) {
    throw new Error(`Amendment already exists: ${id}`);
  }
  const at = new Date(now()).toISOString();
  const first: AmendmentHistoryEntry =
    input.status === 'pending'
      ? { action: 'filed', actor: 'intake', at }
      : {
          action: 'auto_reject',
          actor: 'intake',
          at,
          ...(typeof input.preCheck === 'object' ? { reason: input.preCheck.reason } : {}),
        };
  const record: AmendmentRecord = {
    schemaVersion: 1,
    id,
    personalityId: input.personalityId,
    target: 'toolset',
    ops: canonical.ops,
    opsHash: hashOfOps,
    baseHash: input.baseHash,
    rationale: input.rationale,
    evidence: input.evidence.map((e) => ({ ...e })),
    provenance: { ...input.provenance },
    preCheck: input.preCheck,
    status: input.status,
    history: [first],
    createdAt: at,
    updatedAt: at,
  };
  await storage.mkdir(amendmentDir(dataDir, id));
  await storage.writeAtomic(
    amendmentProposalPath(dataDir, id),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return { kind: 'created', record };
}

/**
 * The transitions a record may take. `stale` → `declined` is how an owner
 * closes out a stale proposal. `stale` → `applied` is crash recovery only: an
 * apply that wrote the live file and died before recording it left the record
 * `pending` (or, before recovery existed, `stale`), and the service completes
 * it once `applied.json` and the live bytes prove the approved write landed
 * (`recoverInterruptedApply`, packages/wiring/src/amendments.ts). Every other
 * status is terminal.
 */
const TRANSITIONS: Record<AmendmentStatus, readonly AmendmentStatus[]> = {
  pending: ['applied', 'declined', 'stale', 'auto_rejected'],
  stale: ['declined', 'applied'],
  applied: ['rolled_back'],
  declined: [],
  auto_rejected: [],
  rolled_back: [],
};

const ACTION_FOR: Record<Exclude<AmendmentStatus, 'pending'>, AmendmentHistoryEntry['action']> = {
  applied: 'approve',
  declined: 'decline',
  auto_rejected: 'auto_reject',
  stale: 'stale',
  rolled_back: 'rollback',
};

export interface AmendmentTransition {
  to: Exclude<AmendmentStatus, 'pending'>;
  actor: AmendmentActor;
  decidedBy?: string;
  reason?: string;
  /** Required for `applied`: the hash of the bytes written. */
  appliedHash?: string;
}

/**
 * Move a record to a new status and append its history entry. Throws when the
 * record is gone, the transition is not in {@link TRANSITIONS}, or `applied`
 * arrives without `appliedHash` — the caller checks status under the lock
 * first, so any of these is a race or a bug, and a silent write would hide it.
 */
export async function transitionAmendment(
  storage: Storage,
  dataDir: string,
  amendmentId: string,
  change: AmendmentTransition,
  now: () => number = Date.now,
): Promise<AmendmentRecord> {
  const current = await readAmendment(storage, dataDir, amendmentId);
  if (!current) throw new Error(`No such amendment: ${amendmentId}`);
  if (!TRANSITIONS[current.status].includes(change.to)) {
    throw new Error(`Amendment ${amendmentId} cannot go from ${current.status} to ${change.to}`);
  }
  if (change.to === 'applied' && !change.appliedHash) {
    throw new Error(`Amendment ${amendmentId}: applied needs appliedHash`);
  }
  const at = new Date(now()).toISOString();
  const entry: AmendmentHistoryEntry = {
    action: ACTION_FOR[change.to],
    actor: change.actor,
    at,
    ...(change.decidedBy ? { decidedBy: change.decidedBy } : {}),
    ...(change.reason ? { reason: change.reason } : {}),
  };
  const next: AmendmentRecord = {
    ...current,
    status: change.to,
    history: [...current.history, entry],
    ...(change.to === 'applied' && change.appliedHash
      ? { applied: { appliedHash: change.appliedHash, at } }
      : {}),
    updatedAt: at,
  };
  await storage.writeAtomic(
    amendmentProposalPath(dataDir, amendmentId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}
