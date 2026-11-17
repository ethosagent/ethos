import type { SecretsResolver } from '@ethosagent/types';

export interface SecretCheckResult {
  key: string;
  present: boolean;
  required: boolean;
  applicable: boolean;
  fillWith: string;
}

export const SECRET_REF_RE = /\$\{secrets:([^}]+)\}/g;

export async function isSet(secrets: SecretsResolver, ref: string): Promise<boolean> {
  const val = await secrets.get(ref);
  return val !== null && val.trim().length > 0;
}

export type CodexModelCheck =
  | { status: 'skipped' }
  | { status: 'unauthorized' }
  | { status: 'unverified'; model: string }
  | { status: 'ok'; model: string }
  | { status: 'unsupported'; model: string; supported: string[] };
