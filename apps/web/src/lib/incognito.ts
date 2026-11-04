// Incognito web sessions (plan incognito-sessions §8.2). Shared copy and the
// URL flag the New Session picker uses to ask for one.

/** Composer placeholder while the active (or about-to-start) chat is incognito. */
export const INCOGNITO_PLACEHOLDER = 'Incognito — not remembered';

/** Query flag on `/p/:id/chat?new=1&incognito=1` (`buildNewSessionPath`). */
export const INCOGNITO_PARAM = 'incognito';
