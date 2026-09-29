import type {
  AmendmentRecordView,
  AmendmentReviewView,
  AmendmentStatusView,
} from '@ethosagent/web-contracts';

// Pure derivations behind the Learning page's read-only "Definition changes"
// section (plan personality-memory-boundary-and-self-amendment G2, D30). No
// React and no fetching, the same split `learning.ts` uses.
//
// The web never applies an amendment in v1: every action is a CLI command the
// owner runs in a terminal (`ethos personality amendments`, D31/D32).

/** What the section lists: requests the owner still has to close. */
export const AMENDMENT_OPEN: readonly AmendmentStatusView[] = ['pending', 'stale'];

/** What the Learning badge counts: requests waiting on a decision. */
export const AMENDMENT_AWAITING: readonly AmendmentStatusView[] = ['pending'];

export const AMENDMENT_STATUS_WORDS: Record<AmendmentStatusView, string> = {
  pending: 'waiting for you',
  applied: 'applied',
  declined: 'declined',
  auto_rejected: 'rejected by the constitution',
  stale: 'stale',
  rolled_back: 'rolled back',
};

/**
 * `+ web_fetch, - terminal`, or for an identity request (the birth ritual,
 * plan personality-presence-and-initiative §1)
 * `name → "Ledger", vibe → "…", emoji → 🧾, avatar → generated mark`.
 * Mirrors `opsLabel` in apps/ethos/src/commands/personality-amendments.ts.
 */
export function opsLabel(record: Pick<AmendmentRecordView, 'ops'>): string {
  return record.ops.map(opLabel).join(', ');
}

function opLabel(o: AmendmentRecordView['ops'][number]): string {
  switch (o.op) {
    case 'add_tool':
      return `+ ${o.tool}`;
    case 'remove_tool':
      return `- ${o.tool}`;
    case 'set_name':
      return `name → "${o.value}"`;
    case 'set_description':
      return `vibe → "${o.value}"`;
    case 'set_display_emoji':
      return `emoji → ${o.value}`;
    case 'set_display_avatar':
      return o.value === 'upload' ? 'avatar → upload after applying' : 'avatar → generated mark';
  }
}

/** True when an identity request leaves the avatar for the owner to upload. */
export function wantsAvatarUpload(record: Pick<AmendmentRecordView, 'ops'>): boolean {
  return record.ops.some((o) => o.op === 'set_display_avatar' && o.value === 'upload');
}

type Direction = NonNullable<AmendmentReviewView['permissionDiff']>['changes'][number]['direction'];

/** State is an icon AND a word, never colour alone (DESIGN.md). Widening is the one to read. */
export const DIRECTION_PILLS: Record<
  Direction,
  { icon: string; word: string; tone: 'bad' | 'ok' | 'wait' }
> = {
  widens: { icon: '▲', word: 'widens', tone: 'bad' },
  narrows: { icon: '▼', word: 'narrows', tone: 'ok' },
  changes: { icon: '~', word: 'changes', tone: 'wait' },
};

export const FLAG_TEXT: Record<AmendmentReviewView['flags'][number], string> = {
  'tool-unavailable': 'an added tool is not available on this machine right now',
  'no-recorded-refusal': 'no refused call was cited as evidence',
  'local-terminal': 'holds a shell tool under local execution',
  'high-risk': 'adds a tool that can run code, write files, spawn agents or create personalities',
  'team-workflow': 'removes a tool a team member needs to report assigned work',
};

/** A `textDiff` line (`' '`, `'-'` or `'+'` prefix) as the diff view's kind. */
export function diffKind(line: string): 'add' | 'del' | 'same' {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'same';
}

/**
 * The terminal command for the owner's next step, or null when there is none.
 * Apply needs a terminal: the CLI refuses without a TTY and asks for the
 * personality id to be typed back (D32).
 */
export function cliCommands(review: AmendmentReviewView): { label: string; command: string }[] {
  const id = review.record.id;
  const decline = {
    label: 'Decline',
    command: `ethos personality amendments decline ${id} --reason "<why>"`,
  };
  switch (review.record.status) {
    case 'pending':
      return review.stale || review.expectedAfterHash === null
        ? [decline]
        : [
            { label: 'Apply from the CLI', command: `ethos personality amendments apply ${id}` },
            decline,
          ];
    case 'stale':
      return [decline];
    case 'applied':
      return [{ label: 'Roll back', command: `ethos personality amendments rollback ${id}` }];
    default:
      return [];
  }
}
