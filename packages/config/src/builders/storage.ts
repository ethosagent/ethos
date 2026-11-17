import type { EthosConfig } from '../config-types';
import { splitList } from './utils';

/**
 * Item 8 — per-key character ceilings for the markdown memory backend. Both
 * fields are positive integers; a non-numeric or non-positive value is dropped
 * so the provider keeps its 512K default. Returns `undefined` when nothing
 * survives, so an absent block never materialises an empty object.
 */
export function buildMemoryCharLimits(
  kv: Record<string, string>,
): EthosConfig['memoryCharLimits'] | undefined {
  const result: NonNullable<EthosConfig['memoryCharLimits']> = {};
  for (const key of ['memory', 'user'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * SEC-001 — `storage.encryption` was removed: it validated ETHOS_STORAGE_KEY and
 * then wrapped only the personality-design tool's storage, so `MEMORY.md`,
 * `USER.md`, personality configs and team memory — what its how-to promised —
 * stayed plaintext. A config that still sets it gets this notice instead of
 * the generic unknown-key one. Pinned by `__tests__/config.test.ts`
 * ('drops storage.encryption and says it was removed').
 */
export function storageEncryptionRemovedNotice(kv: Record<string, string>): string[] {
  if (kv['storage.encryption'] === undefined) return [];
  return [
    "config.yaml: 'storage.encryption' was removed and has no effect — files under " +
      '~/.ethos/ are not encrypted by Ethos. Use full-disk or volume encryption for data ' +
      'at rest. Files the personality-design tool wrote while the flag was on are ' +
      'ciphertext and must be recreated.',
  ];
}

export function buildStorageConfig(kv: Record<string, string>): EthosConfig['storage'] {
  const s3: NonNullable<NonNullable<EthosConfig['storage']>['s3']> = {};
  if (kv['storage.s3.bucket']) s3.bucket = kv['storage.s3.bucket'];
  if (kv['storage.s3.region']) s3.region = kv['storage.s3.region'];
  if (kv['storage.s3.prefix']) s3.prefix = kv['storage.s3.prefix'];
  if (kv['storage.s3.endpoint']) s3.endpoint = kv['storage.s3.endpoint'];
  if (kv['storage.s3.forcePathStyle'] === 'true') s3.forcePathStyle = true;
  const rawBackend = kv['storage.backend'];
  const backend: 'fs' | 's3' | undefined =
    rawBackend === 'fs' || rawBackend === 's3' ? rawBackend : undefined;
  const hasS3 = s3.bucket !== undefined;
  if (backend === undefined && !hasS3) return undefined;
  return {
    ...(backend ? { backend } : {}),
    ...(hasS3 ? { s3 } : {}),
  };
}

export function buildBackupConfig(kv: Record<string, string>): EthosConfig['backup'] {
  const present = Object.keys(kv).some((k) => k.startsWith('backup.'));
  if (!present) return undefined;
  const keepRaw = kv['backup.keep'];
  // Validated as a WHOLE string, not with `parseInt`, which stops at the first
  // non-digit: "7days" would parse as 7 and "1.5" as 1, both silently accepted
  // by a message that promises a positive integer. `isSafeInteger` then rejects
  // a value past 2^53 that `Number` would have rounded to something else.
  const keep = keepRaw !== undefined && /^\d+$/.test(keepRaw) ? Number(keepRaw) : Number.NaN;
  if (keepRaw !== undefined && !(Number.isSafeInteger(keep) && keep >= 1)) {
    throw new Error(`Invalid backup.keep "${keepRaw}". Expected a positive integer.`);
  }
  const scope = splitList(kv['backup.scope']);
  return {
    ...(kv['backup.enabled'] !== undefined ? { enabled: kv['backup.enabled'] === 'true' } : {}),
    ...(kv['backup.cron'] ? { cron: kv['backup.cron'] } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(keepRaw !== undefined ? { keep } : {}),
    ...(kv['backup.dir'] ? { dir: kv['backup.dir'] } : {}),
  };
}

/**
 * `channelDigest.*` (ambient-group-monitoring R3/R9/R10).
 *
 * The two caps are validated as WHOLE strings for the same reason
 * `buildBackupConfig` validates `keep` that way: `parseInt`/`parseFloat` stop
 * at the first character they cannot use, so "500 messages" would be accepted
 * as 500 and "0.5usd" as 0.5 by a message promising a number. A cap of zero is
 * refused rather than silently meaning "no digest at all".
 */
export function buildChannelDigestConfig(kv: Record<string, string>): EthosConfig['channelDigest'] {
  const present = Object.keys(kv).some((k) => k.startsWith('channelDigest.'));
  if (!present) return undefined;

  const deliverToRaw = kv['channelDigest.deliverTo'];
  if (deliverToRaw !== undefined && deliverToRaw !== 'owner' && deliverToRaw !== 'inApp') {
    throw new Error(
      `Invalid channelDigest.deliverTo "${deliverToRaw}". Expected 'owner' or 'inApp'.`,
    );
  }

  const maxMessagesRaw = kv['channelDigest.maxMessagesPerLane'];
  const maxMessages =
    maxMessagesRaw !== undefined && /^\d+$/.test(maxMessagesRaw)
      ? Number(maxMessagesRaw)
      : Number.NaN;
  if (maxMessagesRaw !== undefined && !(Number.isSafeInteger(maxMessages) && maxMessages >= 1)) {
    throw new Error(
      `Invalid channelDigest.maxMessagesPerLane "${maxMessagesRaw}". Expected a positive integer.`,
    );
  }

  const maxLanesRaw = kv['channelDigest.maxLanesPerRun'];
  const maxLanes =
    maxLanesRaw !== undefined && /^\d+$/.test(maxLanesRaw) ? Number(maxLanesRaw) : Number.NaN;
  if (maxLanesRaw !== undefined && !(Number.isSafeInteger(maxLanes) && maxLanes >= 1)) {
    throw new Error(
      `Invalid channelDigest.maxLanesPerRun "${maxLanesRaw}". Expected a positive integer.`,
    );
  }

  const costWarnRaw = kv['channelDigest.costWarnUsdPerLane'];
  const costWarn =
    costWarnRaw !== undefined && /^\d+(\.\d+)?$/.test(costWarnRaw)
      ? Number(costWarnRaw)
      : Number.NaN;
  if (costWarnRaw !== undefined && !(Number.isFinite(costWarn) && costWarn > 0)) {
    throw new Error(
      `Invalid channelDigest.costWarnUsdPerLane "${costWarnRaw}". Expected a positive number.`,
    );
  }

  return {
    ...(kv['channelDigest.enabled'] !== undefined
      ? { enabled: kv['channelDigest.enabled'] === 'true' }
      : {}),
    ...(kv['channelDigest.cron'] ? { cron: kv['channelDigest.cron'] } : {}),
    ...(deliverToRaw !== undefined ? { deliverTo: deliverToRaw } : {}),
    ...(maxMessagesRaw !== undefined ? { maxMessagesPerLane: maxMessages } : {}),
    ...(maxLanesRaw !== undefined ? { maxLanesPerRun: maxLanes } : {}),
    ...(costWarnRaw !== undefined ? { costWarnUsdPerLane: costWarn } : {}),
  };
}

/**
 * Phase 3 — assemble the memory-consolidation (silent flush) config from parsed
 * flat keys. `flushThreshold` is a fraction in (0,1]; the caps are non-negative
 * integers. Returns `undefined` when nothing survives so the loop stays opt-out.
 */
export function buildMemoryConsolidation(
  kv: Record<string, string>,
): EthosConfig['memoryConsolidation'] | undefined {
  const result: NonNullable<EthosConfig['memoryConsolidation']> = {};
  if (kv.enabled === 'true') result.enabled = true;
  else if (kv.enabled === 'false') result.enabled = false;
  const threshold = kv.flushThreshold;
  if (threshold !== undefined) {
    const n = Number(threshold);
    if (Number.isFinite(n) && n > 0 && n <= 1) result.flushThreshold = n;
  }
  for (const key of ['timeboxMs', 'maxTokens', 'maxDeltaChars', 'minMessagesSinceFlush'] as const) {
    const raw = kv[key];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) result[key] = Math.floor(n);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
