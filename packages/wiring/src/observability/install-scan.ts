// The `install.scan` audit row: one per install-scanner decision (`scanSkillMd`
// / `scanPluginCode` + `canInstall`) at install or promotion time. Built here so
// every emitter — `ethos skills install` (`scanSkillDir`,
// apps/ethos/src/commands/skills.ts), `ethos plugin install` (`installPlugin`,
// apps/ethos/src/commands/plugin.ts) and learning promotion (`learningPromoteDeps`,
// ./learning-pipeline.ts) — writes the same shape through
// `EthosObservability.recordSkillScan`.
//
// What the row carries: the verdict, the tier, counts, and the rule ids. What it
// never carries: a finding's `excerpt` or `message` (both quote the scanned
// file), or the file body. A `source` that is a URL has its userinfo removed,
// since an npm spec may be `https://<token>@host/...`.

import type { InstallDecision, ScanResult, TrustTier } from '@ethosagent/safety-scanner';

/**
 * `pass` — no findings. `warn` — findings, allowed anyway (a tier that
 * auto-acknowledges yellow). `needs_ack` — yellow findings the tier will not
 * auto-acknowledge; the caller asks for consent or refuses. `blocked` — red.
 */
export type InstallScanVerdict = 'pass' | 'warn' | 'needs_ack' | 'blocked';

export interface InstallScanInput {
  kind: 'skill' | 'plugin';
  /** What was scanned: a skill slug, an npm spec, or `learning:<candidateId>`. */
  source: string;
  tier: TrustTier;
  scan: Pick<ScanResult, 'findings' | 'hasRed' | 'hasYellow'>;
  decision: InstallDecision;
  /** Extra identifying fields (never file content). */
  details?: Record<string, unknown>;
}

export interface InstallScanEvent {
  code: `install.scan.${InstallScanVerdict}`;
  severity: 'info' | 'warn';
  details: Record<string, unknown>;
}

function verdictOf(input: InstallScanInput): InstallScanVerdict {
  const { scan, decision } = input;
  if (!decision.allowed) return scan.hasRed ? 'blocked' : 'needs_ack';
  return scan.hasRed || scan.hasYellow ? 'warn' : 'pass';
}

function stripUserinfo(source: string): string {
  return source.replace(/(\/\/)[^/@\s]+@/, '$1');
}

export function installScanEvent(input: InstallScanInput): InstallScanEvent {
  const verdict = verdictOf(input);
  const { findings } = input.scan;
  return {
    code: `install.scan.${verdict}`,
    severity: input.decision.allowed ? 'info' : 'warn',
    details: {
      kind: input.kind,
      source: stripUserinfo(input.source),
      tier: input.tier,
      verdict,
      ...(input.decision.blockedBy ? { blockedBy: input.decision.blockedBy } : {}),
      findingCount: findings.length,
      redCount: findings.filter((f) => f.severity === 'red').length,
      yellowCount: findings.filter((f) => f.severity === 'yellow').length,
      rules: [...new Set(findings.map((f) => f.rule))].sort(),
      ...input.details,
    },
  };
}
