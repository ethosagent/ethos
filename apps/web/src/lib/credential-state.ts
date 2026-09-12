// Maps a credential probe row onto the three UI states of §10.2 / D11
// (plan/phases/tool-credential-surface.md). Pure — no React, no RPC.

export type CredentialRung =
  | 'personality'
  | 'global-personality'
  | 'global-default'
  | 'tool-default';

export type CredentialOrigin = 'set-here' | 'inherited' | 'unset';

export type CredentialUiState = 'unset' | 'inherited' | 'overridden';

export interface CredentialProbeInput {
  present: boolean;
  rung: CredentialRung;
  /** Wire origin when present; otherwise derived from rung + present (§10.2). */
  origin?: CredentialOrigin;
  ref: string;
  key: string;
  toolNames: string[];
}

export interface CredentialStateDescription {
  state: CredentialUiState;
  message: string;
  /** Last path segment of `ref` (e.g. `providers/xai/seoMain` → `seoMain`). */
  secretName?: string;
}

/** Extract the secret NAME from a vault ref — last segment after `/`. */
export function secretNameFromRef(ref: string): string | undefined {
  const i = ref.lastIndexOf('/');
  if (i < 0 || i === ref.length - 1) return undefined;
  return ref.slice(i + 1);
}

function stateFromOrigin(origin: CredentialOrigin): CredentialUiState {
  if (origin === 'unset') return 'unset';
  if (origin === 'inherited') return 'inherited';
  return 'overridden';
}

/** §10.2: unset when absent; overridden for personality / global-personality;
 *  inherited for global-default / tool-default. */
function stateFromRung(present: boolean, rung: CredentialRung): CredentialUiState {
  if (!present) return 'unset';
  if (rung === 'personality' || rung === 'global-personality') return 'overridden';
  return 'inherited';
}

/**
 * Derive the three-state credential copy for a probe row.
 * Prefers wire `origin` when set; otherwise derives from rung + present.
 */
export function describeCredentialState(probe: CredentialProbeInput): CredentialStateDescription {
  const state =
    probe.origin !== undefined
      ? stateFromOrigin(probe.origin)
      : stateFromRung(probe.present, probe.rung);
  const secretName = secretNameFromRef(probe.ref);

  if (state === 'unset') {
    return {
      state,
      message: `${probe.key} needs a key. ${probe.toolNames.join(', ')} use it.`,
    };
  }
  if (state === 'inherited') {
    return {
      state,
      message: secretName ? `Using the global key ${secretName}.` : 'Using the global key.',
      ...(secretName !== undefined ? { secretName } : {}),
    };
  }
  return {
    state,
    message: secretName ? `This personality uses ${secretName}.` : 'This personality uses a key.',
    ...(secretName !== undefined ? { secretName } : {}),
  };
}
