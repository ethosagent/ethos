import type { KeylessCandidate } from '@ethosagent/web-contracts';

// Copy for a local model server whose served context window is under the floor.
// No wiring in the browser, so this mirrors `belowFloorHint` in
// packages/wiring/src/keyless-probe.ts; the floor check itself is in
// extensions/llm-openai-compat/src/index.ts and this text is pinned by
// __tests__/local-floor.test.ts.

type LocalCandidate = Extract<KeylessCandidate, { kind: 'local' }>;

/** Remediation sentence, or null when the candidate is usable. */
export function belowFloorText(c: LocalCandidate): string | null {
  const b = c.belowContextFloor;
  if (!b) return null;
  // OLLAMA_CONTEXT_LENGTH is believed, not verified, to be Ollama's setting.
  const fix =
    c.runtime === 'ollama'
      ? 'Restart Ollama with a larger context (e.g. OLLAMA_CONTEXT_LENGTH=16384)'
      : 'Raise its context length (--max-model-len / -c / model settings)';
  return `Serves ${b.servedTokens} tokens; Ethos needs ${b.floorTokens}. ${fix}, then check again.`;
}
