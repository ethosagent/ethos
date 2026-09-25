// Spend and token formatting for the Usage tab and the chat header's session
// cost (plan openclaw-2026.9.6-gaps U3). Same rule the right drawer's usage
// block and the Sessions table already draw: whole cents, `<$0.01` below that.

/** `$0`, `<$0.01`, or dollars to the cent. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** `950`, `12.3k`, `4.1M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
