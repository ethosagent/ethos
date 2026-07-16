// Compact formatter for the composer's context-size indicator.
//   < 1000        → exact             (820)
//   >= 1000       → one-decimal `k`   (12.4k), trailing `.0` trimmed (12k)
//   >= 1_000_000  → one-decimal `M`   (1.2M),  trailing `.0` trimmed (2M)
export function formatContextTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimTrailingZero((n / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((n / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
