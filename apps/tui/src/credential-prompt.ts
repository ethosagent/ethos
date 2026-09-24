// Masked credential request (plan openclaw-9.5-adoption item 1) — the pure
// half of the TUI surface. `CredentialModal` owns the keystrokes and the
// rendering; this file owns what a keystroke does to the value, what the
// value looks like on screen, and what Enter does with it, so all three are
// testable without an Ink renderer (pinned by
// `apps/tui/src/__tests__/credential-prompt.test.ts`).

import type { AgentEvent } from '@ethosagent/types';

/** The `credential_required` payload as `AgentBridge` emits it (minus `type`). */
export type CredentialRequest = Omit<Extract<AgentEvent, { type: 'credential_required' }>, 'type'>;

/** Stores one plugin credential — the host passes `PluginLoader.setCredential`. */
export type SetPluginCredential = (pluginId: string, key: string, value: string) => Promise<void>;

export type MaskedInputAction =
  | { type: 'input'; text: string }
  | { type: 'backspace' }
  | { type: 'clear' };

export const MASK_CHAR = '•';

/**
 * The next value of the masked field. Typed and pasted text is appended with
 * line breaks stripped — a secret never legitimately contains one, and a
 * pasted trailing newline would otherwise be stored as part of the key.
 */
export function maskedInputReducer(value: string, action: MaskedInputAction): string {
  switch (action.type) {
    case 'input':
      return value + action.text.replace(/[\r\n]/g, '');
    case 'backspace':
      return Array.from(value).slice(0, -1).join('');
    case 'clear':
      return '';
  }
}

/** What the screen shows for `value`: one `•` per character, never the value. */
export function maskValue(value: string): string {
  return MASK_CHAR.repeat(Array.from(value).length);
}

/** The subset of Ink's `Key` the modal reads. */
export interface CredentialKey {
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export type CredentialKeyStep =
  | { kind: 'edit'; value: string }
  | { kind: 'submit'; value: ''; submitted: string }
  | { kind: 'cancel'; value: '' };

/**
 * One keystroke in the modal. Enter hands the typed value out as `submitted`
 * and empties the field in the same step; Esc empties it and submits nothing.
 */
export function credentialKeyStep(
  value: string,
  input: string,
  key: CredentialKey,
): CredentialKeyStep {
  if (key.escape) return { kind: 'cancel', value: '' };
  if (key.return) return { kind: 'submit', value: '', submitted: value };
  if (key.backspace || key.delete) {
    return { kind: 'edit', value: maskedInputReducer(value, { type: 'backspace' }) };
  }
  if (input && !key.ctrl && !key.meta) {
    return { kind: 'edit', value: maskedInputReducer(value, { type: 'input', text: input }) };
  }
  return { kind: 'edit', value };
}

export type SubmitCredentialResult = { ok: true } | { ok: false; error: string };

/**
 * Enter on the modal. Stores the value through the ONE writer the host
 * supplies, and only once that resolves resends the refused message. A throw
 * (e.g. `Plugin "<id>" is not loaded`) returns its text and resends nothing.
 * An empty value is refused before any store.
 */
export async function submitCredential(args: {
  request: CredentialRequest;
  value: string;
  setPluginCredential: SetPluginCredential;
  resend: (pendingUserMessage: string) => void;
}): Promise<SubmitCredentialResult> {
  const { request, value, setPluginCredential, resend } = args;
  if (!value.trim()) return { ok: false, error: 'Enter a value, or press Esc to cancel.' };
  try {
    await setPluginCredential(request.pluginId, request.credentialKey, value);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  resend(request.pendingUserMessage);
  return { ok: true };
}
