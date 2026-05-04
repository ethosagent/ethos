export type FindingSeverity = 'red' | 'yellow';

export interface ScanFinding {
  severity: FindingSeverity;
  rule: string;
  message: string;
  line?: number;
  excerpt?: string;
}

export interface ScanResult {
  findings: ScanFinding[];
  hasRed: boolean;
  hasYellow: boolean;
}

export type TrustTier = 'builtin' | 'trusted-repo' | 'community' | 'untrusted';

export interface TierPolicy {
  tier: TrustTier;
  /** Whether the owner can override a red finding to force-install. */
  canOverrideRed: boolean;
  /** Yellow findings are silently acknowledged without user interaction. */
  autoAcknowledgeYellow: boolean;
}
