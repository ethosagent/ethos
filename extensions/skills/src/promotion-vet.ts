// EVO-001 — the gate a learning candidate crosses before it becomes a live
// skill file. Injected into `promote()` (`extensions/learning-inbox/src/promote.ts`)
// as `PromoteDeps.vetSkill` by `learningPromoteDeps` (packages/wiring/src/learning-pipeline.ts),
// which calls `vetPromotedSkillWithScan` so it can also record the `install.scan` row.

import {
  canInstall,
  type InstallDecision,
  type ScanResult,
  scanSkillMd,
  type TrustTier,
} from '@ethosagent/safety-scanner';
import matter from 'gray-matter';

/**
 * Remove the frontmatter keys a generated skill must not carry because they
 * GRANT something rather than describe the skill. Today that is one key:
 * `ethos.permissions.mcp_env_passthrough`, which `deriveSkillPassthrough`
 * (packages/wiring/src/skill-passthrough.ts) turns into host env vars
 * forwarded to MCP subprocesses. Every other `ethos.permissions` field is a
 * self-reported label or (`tools_required`) a narrowing predicate, so it stays.
 *
 * Returns `md` unchanged (byte for byte) when the key is absent; otherwise the
 * frontmatter is re-serialised without it. Unparseable frontmatter is returned
 * unchanged — `checkSkillFrontmatter` refuses it before this runs.
 */
export function stripModelOwnedSkillKeys(md: string): string {
  let file: matter.GrayMatterFile<string>;
  try {
    // `{}` bypasses gray-matter's module cache (see `checkSkillFrontmatter`).
    file = matter(md, {});
  } catch {
    return md;
  }
  const ethos = asRecord(file.data.ethos);
  const perms = asRecord(ethos?.permissions);
  if (!ethos || !perms || !('mcp_env_passthrough' in perms)) return md;
  delete perms.mcp_env_passthrough;
  if (Object.keys(perms).length === 0) delete ethos.permissions;
  if (Object.keys(ethos).length === 0) delete file.data.ethos;
  return matter.stringify(file.content, file.data);
}

/**
 * Strip the model-owned grant keys, then run the same static scan a skill
 * install runs (`scanSkillMd` + `canInstall`) on the bytes that will be
 * written. The tier is `community`: machine-generated text has no author to
 * vouch for it, so a red finding cannot be overridden and an unacknowledged
 * yellow finding refuses, as it would at discovery (`UniversalScanner`).
 */
export function vetPromotedSkill(
  md: string,
): { ok: true; content: string } | { ok: false; error: string } {
  return vetPromotedSkillWithScan(md).result;
}

/**
 * `vetPromotedSkill`, plus the scan and decision it was based on — for the
 * `install.scan` audit row `learningPromoteDeps`
 * (packages/wiring/src/learning-pipeline.ts) records per promotion.
 */
export function vetPromotedSkillWithScan(md: string): {
  result: { ok: true; content: string } | { ok: false; error: string };
  scan: ScanResult;
  decision: InstallDecision;
  tier: TrustTier;
} {
  const content = stripModelOwnedSkillKeys(md);
  const tier: TrustTier = 'community';
  const scan = scanSkillMd(content);
  const decision = canInstall(scan, tier);
  const result = decision.allowed
    ? { ok: true as const, content }
    : { ok: false as const, error: `safety scan: ${decision.blockedBy ?? 'refused'}` };
  return { result, scan, decision, tier };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
