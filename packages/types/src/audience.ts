// Who can read the conversation a turn runs in, and who started it
// (plan personality-memory-boundary-and-self-amendment, G1).
//
// `TurnAudience` is separate from `isDm`: `isDm` decides who may talk to the
// bot (admission, engagement, approval binding); the audience decides only what
// private memory the turn may touch. `'shared'` only ever narrows — the running
// turn's audience is resolved by `resolveTurnAudience`
// (packages/core/src/agent-loop/audience.ts).

/**
 * `'private'` — one person reads the conversation (an owner DM, the CLI, the
 * web app). `'shared'` — more than one person can, or Ethos cannot prove
 * otherwise. Absent on `RunOptions` means private (today's behaviour).
 */
export type TurnAudience = 'private' | 'shared';

/**
 * `'user'` — a person started this turn by sending a message. `'system'` — a
 * schedule, wake, webhook or bearer-key client did. Absent means the caller
 * did not say. Children never inherit it.
 */
export type TurnInitiator = 'user' | 'system';
