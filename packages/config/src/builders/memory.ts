import { splitList } from './utils';

/**
 * Proactive memory capture (memory-experience pillar B). Default-OFF: absent or
 * `enabled !== true` means no capture runner is wired and behaviour is
 * unchanged (opt-in for one release). `model` (+ optional provider/apiKey/
 * baseUrl) selects the cheap auxiliary model for the single extraction call per
 * turn; when unset the primary model is reused. Rate caps default to 6/hour,
 * 30/day per scope. Config keys:
 *   memoryCapture.enabled: true
 *   memoryCapture.model: claude-haiku-4-5-20251001
 *   memoryCapture.maxPerHour: 6
 *   memoryCapture.maxPerDay: 30
 *   memoryCapture.evidenceSessions: 3
 */
export interface MemoryCaptureConfig {
  enabled?: boolean;
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxPerHour?: number;
  maxPerDay?: number;
  /**
   * Recurrence-evidence threshold (plan openclaw-9.5-adoption item 3, D22):
   * the number of distinct sessions that must extract the same fact before it
   * is promoted. `0` or absent = off (capture behaves as before). With
   * `memoryApproval.mode: off` a fact is held in the pending queue until it
   * reaches N and is then approved as `evidence`; with `automated`/`all` the
   * count only orders the queue for a human. An integer in 0..16 —
   * `buildMemoryCaptureConfig` refuses anything else (16 is
   * `MAX_EVIDENCE_SESSIONS` in `@ethosagent/memory-approval`).
   */
  evidenceSessions?: number;
}

/**
 * Bring-your-own-vault memory backend (memory-lifecycle L1). Read only when
 * `memory: vault`. Parsed from flat `memoryVault.<field>` keys:
 *   memoryVault.path: /Users/you/Documents/ObsidianVault
 *   memoryVault.agentDir: Ethos
 *   memoryVault.prefetch: MEMORY.md, USER.md
 *   memoryVault.exclude: Archive, Templates
 */
export interface MemoryVaultConfig {
  /** Absolute path to the vault root (the Obsidian folder). */
  path?: string;
  /** Subtree the agent owns; scopes route beneath it. Default `Ethos`. */
  agentDir?: string;
  /** Keys prefetched into the prompt tail. Default `MEMORY.md`, `USER.md`. */
  prefetch?: string[];
  /** Directory / file names hidden from list + search. */
  exclude?: string[];
}

/**
 * Approve-before-store gate (memory-lifecycle L2, §3b). Default-OFF: absent or
 * `mode: off` means every memory write lands durably as before (opt-in for one
 * release, matching the capture/dedup-hatch precedent). Parsed from flat
 * `memoryApproval.<field>` keys:
 *   memoryApproval.mode: automated   # off | automated | all
 *   memoryApproval.cap: 200          # per-scope queue hard cap
 *   memoryApproval.ttlDays: 30       # pending candidates auto-reject after N days
 *
 * `automated` gates the autonomous writers (`capture`, `dream`); `all` also
 * gates explicit tool/consolidation writes. Approved candidates replay through
 * the provenance history under their original source plus `approvedBy`.
 */
export interface MemoryApprovalConfig {
  mode?: 'off' | 'automated' | 'all';
  /** Per-scope pending-queue hard cap. At cap the oldest is dropped. Default 200. */
  cap?: number;
  /** Pending candidate TTL in days; expired candidates auto-reject. Default 30. */
  ttlDays?: number;
}

/**
 * Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
 * All optional — the nightly pass applies defaults (30-day half-life, 0.05
 * archive threshold, USER.md exempt). Parsed from flat `memoryConsolidation.<field>`
 * keys.
 */
export interface MemoryConsolidationConfig {
  // Importance scoring + decay tuning (memory-experience pillar C, §4.2/§4.3).
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Effective weight below which a section is archived. Default 0.05. */
  threshold?: number;
  /** Exempt USER.md from decay entirely. Default true. */
  exemptUser?: boolean;
  // Silent memory-flush turn (context-compaction Phase 3). At a soft threshold
  // (default 70% of the model-aware gate) a non-persisted agentic turn,
  // restricted to the memory tools, consolidates durable facts into
  // MEMORY.md / USER.md before auto-compaction later drops raw history.
  /** Enable the opt-in silent memory-flush turn. */
  enabled?: boolean;
  /** Soft threshold (fraction of the model-aware gate) that triggers the flush. Default 0.7. */
  flushThreshold?: number;
  /** Timebox for the flush turn in ms. Default 30000. */
  timeboxMs?: number;
  /** Max tokens for the flush turn. Default 1024. */
  maxTokens?: number;
  /** Max delta chars written per flush. Default 4000. */
  maxDeltaChars?: number;
  /** Minimum messages since last flush before another runs. Default 8. */
  minMessagesSinceFlush?: number;
}

export function buildMemoryCaptureConfig(
  kv: Record<string, string>,
): MemoryCaptureConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryCapture.'));
  if (!present) return undefined;
  const maxPerHour = Number.parseInt(kv['memoryCapture.maxPerHour'] ?? '', 10);
  const maxPerDay = Number.parseInt(kv['memoryCapture.maxPerDay'] ?? '', 10);
  const evidenceRaw = kv['memoryCapture.evidenceSessions'];
  // Whole-string match, not parseInt: `3.5` or `3x` must be refused, not
  // silently read as 3. The ceiling is memory-approval's MAX_EVIDENCE_SESSIONS
  // (an entry records at most 16 sessions, so a higher threshold never fires).
  if (evidenceRaw !== undefined && (!/^\d+$/.test(evidenceRaw) || Number(evidenceRaw) > 16)) {
    throw new Error(
      `Invalid memoryCapture.evidenceSessions "${evidenceRaw}". Expected an integer from 0 to 16.`,
    );
  }
  return {
    ...(kv['memoryCapture.enabled'] !== undefined
      ? { enabled: kv['memoryCapture.enabled'] === 'true' }
      : {}),
    ...(kv['memoryCapture.model'] ? { model: kv['memoryCapture.model'] } : {}),
    ...(kv['memoryCapture.provider'] ? { provider: kv['memoryCapture.provider'] } : {}),
    ...(kv['memoryCapture.apiKey'] ? { apiKey: kv['memoryCapture.apiKey'] } : {}),
    ...(kv['memoryCapture.baseUrl'] ? { baseUrl: kv['memoryCapture.baseUrl'] } : {}),
    ...(Number.isFinite(maxPerHour) ? { maxPerHour } : {}),
    ...(Number.isFinite(maxPerDay) ? { maxPerDay } : {}),
    ...(evidenceRaw !== undefined ? { evidenceSessions: Number(evidenceRaw) } : {}),
  };
}

export function buildMemoryVaultConfig(kv: Record<string, string>): MemoryVaultConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryVault.'));
  if (!present) return undefined;
  const prefetch = splitList(kv['memoryVault.prefetch']);
  const exclude = splitList(kv['memoryVault.exclude']);
  return {
    ...(kv['memoryVault.path'] ? { path: kv['memoryVault.path'] } : {}),
    ...(kv['memoryVault.agentDir'] ? { agentDir: kv['memoryVault.agentDir'] } : {}),
    ...(prefetch.length > 0 ? { prefetch } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

export function buildMemoryApprovalConfig(
  kv: Record<string, string>,
): MemoryApprovalConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryApproval.'));
  if (!present) return undefined;
  const mode = kv['memoryApproval.mode'];
  if (mode !== undefined && mode !== 'off' && mode !== 'automated' && mode !== 'all') {
    throw new Error(`Invalid memoryApproval.mode "${mode}". Expected one of: off, automated, all.`);
  }
  const cap = Number.parseInt(kv['memoryApproval.cap'] ?? '', 10);
  const ttlDays = Number.parseInt(kv['memoryApproval.ttlDays'] ?? '', 10);
  if (kv['memoryApproval.cap'] !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
    throw new Error(
      `Invalid memoryApproval.cap "${kv['memoryApproval.cap']}". Expected a positive integer.`,
    );
  }
  if (kv['memoryApproval.ttlDays'] !== undefined && (!Number.isFinite(ttlDays) || ttlDays <= 0)) {
    throw new Error(
      `Invalid memoryApproval.ttlDays "${kv['memoryApproval.ttlDays']}". Expected a positive integer.`,
    );
  }
  return {
    ...(mode !== undefined ? { mode: mode as MemoryApprovalConfig['mode'] } : {}),
    ...(Number.isFinite(cap) && cap > 0 ? { cap } : {}),
    ...(Number.isFinite(ttlDays) && ttlDays > 0 ? { ttlDays } : {}),
  };
}

export function buildMemoryConsolidationConfig(
  kv: Record<string, string>,
): MemoryConsolidationConfig | undefined {
  const present = Object.keys(kv).some((k) => k.startsWith('memoryConsolidation.'));
  if (!present) return undefined;
  const halfLifeDays = Number.parseFloat(kv['memoryConsolidation.halfLifeDays'] ?? '');
  const threshold = Number.parseFloat(kv['memoryConsolidation.threshold'] ?? '');
  return {
    ...(Number.isFinite(halfLifeDays) ? { halfLifeDays } : {}),
    ...(Number.isFinite(threshold) ? { threshold } : {}),
    ...(kv['memoryConsolidation.exemptUser'] !== undefined
      ? { exemptUser: kv['memoryConsolidation.exemptUser'] === 'true' }
      : {}),
  };
}
