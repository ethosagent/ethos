// Pure state machine for the Esc Esc "backtrack to an earlier prompt" strip.

/** Two Escapes within this many ms open the backtrack strip. */
export const DOUBLE_ESC_MS = 500;

export function isDoubleEsc(lastEscAt: number | null, now: number): boolean {
  return lastEscAt !== null && now - lastEscAt <= DOUBLE_ESC_MS;
}

/** `index` 0 is the latest prompt; `count` is how many prompts can be picked. */
export interface BacktrackState {
  index: number;
  count: number;
}

export type BacktrackKey = 'older' | 'newer' | 'pick' | 'cancel';

export function stepBacktrack(
  s: BacktrackState,
  k: BacktrackKey,
): { state: BacktrackState } | { done: 'pick'; index: number } | { done: 'cancel' } {
  switch (k) {
    case 'older':
      return { state: { ...s, index: Math.min(s.count - 1, s.index + 1) } };
    case 'newer':
      return s.index === 0 ? { done: 'cancel' } : { state: { ...s, index: s.index - 1 } };
    case 'pick':
      return { done: 'pick', index: s.index };
    case 'cancel':
      return { done: 'cancel' };
  }
}
