// Whisper-style hallucination filter for empty / boilerplate transcripts.
// Reimplemented locally (mirrors the gateway voice-pipeline heuristic) so this
// package has no cross-extension dependency.

const HALLUCINATION_PATTERNS = [
  /^thanks?\s*(you\s*)?(for\s+)?(watching|listening|viewing)/i,
  /^please\s+(like\s+and\s+)?subscribe/i,
  /^(sub(scribe)?|like)\s+(to\s+)?(the\s+)?channel/i,
  /^\s*$/,
  /^\.+$/,
  /^you$/i,
  /^(music|applause|laughter)\s*$/i,
  /^\[.*\]\s*$/,
];

export function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return HALLUCINATION_PATTERNS.some((p) => p.test(trimmed));
}
