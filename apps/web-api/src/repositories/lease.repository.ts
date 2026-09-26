import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type ApprovalLease, isLeaseActive, type Storage } from '@ethosagent/types';
import { z } from 'zod';
import { requireStorage } from './require-storage';

// `<dataDir>/approval-leases.json` — time-limited approval grants
// (reach-and-containment 3b). A lease answers "allow" for one tool, any args,
// in one session, for one personality, until it expires or is revoked. The
// shape and the activity rule live in `@ethosagent/types` (`ApprovalLease`,
// `isLeaseActive`); this is the one store.
//
// Persisted rather than in-memory (D3-9): revocation and the Settings list need
// a durable record, and the audit trail names lease ids. Same pattern as
// `AllowlistRepository` beside it: Storage.writeAtomic, writes serialised on
// `writeChain`, zod-guarded reads that DROP malformed rows — a tampered row
// must never become a grant.

/** Rows expired or revoked longer ago than this are pruned on the next grant. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const leaseSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  sessionId: z.string(),
  personalityId: z.string().nullable(),
  grantedBy: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

interface FileShape {
  leases: ApprovalLease[];
}

export interface LeaseGrantInput {
  toolName: string;
  sessionId: string;
  personalityId: string | null;
  grantedBy: string;
}

export interface LeaseRepositoryOptions {
  /** Where `~/.ethos` lives. The file is `<dataDir>/approval-leases.json`. */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /** Clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class LeaseRepository {
  private readonly storage: Storage;
  private readonly path: string;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: LeaseRepositoryOptions) {
    this.storage = requireStorage(opts.storage, 'LeaseRepository');
    this.path = join(opts.dataDir, 'approval-leases.json');
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record a new lease that ends `ttlMs` from now. Also prunes rows that
   * expired or were revoked more than seven days ago, so the file stays
   * bounded without a sweeper.
   */
  async grant(input: LeaseGrantInput, ttlMs: number): Promise<ApprovalLease> {
    const nowMs = this.now();
    const lease: ApprovalLease = {
      id: randomUUID(),
      toolName: input.toolName,
      sessionId: input.sessionId,
      personalityId: input.personalityId,
      grantedBy: input.grantedBy,
      grantedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      revokedAt: null,
    };
    await this.mutate((file) => {
      file.leases = file.leases.filter((l) => !isPrunable(l, nowMs));
      file.leases.push(lease);
    });
    return lease;
  }

  /**
   * The active lease for exactly this tool + session + personality, or null.
   * `personalityId` matches strictly: a lease bound to an id never matches a
   * call without one, and a `null` lease never matches a call with one (D3-7).
   */
  async findActive(
    toolName: string,
    sessionId: string,
    personalityId: string | null,
    nowMs: number,
  ): Promise<ApprovalLease | null> {
    const file = await this.readSafe();
    return (
      file.leases.find(
        (l) =>
          l.toolName === toolName &&
          l.sessionId === sessionId &&
          l.personalityId === personalityId &&
          isLeaseActive(l, nowMs),
      ) ?? null
    );
  }

  /** Every well-formed row, active or not. */
  async list(): Promise<ApprovalLease[]> {
    return (await this.readSafe()).leases;
  }

  /**
   * Mark a lease revoked. Returns the revoked lease, or null when no such id
   * exists. Revoking an already-revoked lease keeps its original `revokedAt`.
   */
  async revoke(id: string): Promise<ApprovalLease | null> {
    let revoked: ApprovalLease | null = null;
    await this.mutate((file) => {
      const lease = file.leases.find((l) => l.id === id);
      if (!lease) return;
      lease.revokedAt ??= new Date(this.now()).toISOString();
      revoked = { ...lease };
    });
    return revoked;
  }

  private async mutate(apply: (file: FileShape) => void): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const file = await this.readSafe();
      apply(file);
      await this.storage.mkdir(dirname(this.path));
      await this.storage.writeAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
    });
    await this.writeChain;
  }

  private async readSafe(): Promise<FileShape> {
    const raw = await this.storage.read(this.path);
    if (!raw) return { leases: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { leases: [] };
    }
    const rows =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { leases?: unknown }).leases)
        ? (parsed as { leases: unknown[] }).leases
        : [];
    const leases: ApprovalLease[] = [];
    for (const row of rows) {
      const result = leaseSchema.safeParse(row);
      if (result.success) leases.push(result.data);
    }
    return { leases };
  }
}

function isPrunable(lease: ApprovalLease, nowMs: number): boolean {
  const cutoff = nowMs - PRUNE_AFTER_MS;
  if (lease.revokedAt !== null) {
    const revoked = Date.parse(lease.revokedAt);
    return !Number.isFinite(revoked) || revoked < cutoff;
  }
  const end = Date.parse(lease.expiresAt);
  return !Number.isFinite(end) || end < cutoff;
}
