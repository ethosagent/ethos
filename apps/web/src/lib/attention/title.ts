// `(N) ` prefix where N is a positive integer (no leading zero, so `(0)` is not one).
const PREFIX = /^\([1-9]\d*\) /;

export function stripAttentionPrefix(title: string): string {
  return title.replace(PREFIX, '');
}

export function formatAttentionTitle(base: string, count: number): string {
  const stripped = stripAttentionPrefix(base);
  return count <= 0 ? stripped : `(${count}) ${stripped}`;
}
