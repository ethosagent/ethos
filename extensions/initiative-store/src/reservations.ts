import type Database from '@ethosagent/sqlite';
import type {
  ReservationScope,
  WindowReservationRequest,
  WindowReservationResult,
} from '@ethosagent/types';

/**
 * Cross-process day-cap reservations. A run reads what is left of the day before it starts but
 * its spend lands only when its window closes, so two processes (`ethos serve`'s tick and
 * `ethos initiatives run`) could both spend the same remaining dollars. The enforcer is the
 * `window_reservations` table: `reserveAndOpenWindow` checks, inside the caller's
 * `BEGIN IMMEDIATE` transaction, that cap - spent - live reservations covers the request for the
 * initiative, personality, global and pool scopes (and, for an exploring window, the exploration's
 * budget less its spend less live holds), then inserts the reservation with the window
 * row. A live window renews its hold on every spend (`touchWindow`), so the TTL frees only a
 * process that stopped. Pinned by __tests__/reservations.test.ts.
 */

const EPSILON = 1e-9;

/** `spent` and `held` are `[sql, ...params]`; each sql returns one row `{ n }`. */
interface Scope {
  scope: ReservationScope;
  cap: number | undefined;
  spent: [string, ...unknown[]];
  held: [string, ...unknown[]];
}

function scopes(
  r: WindowReservationRequest,
  initiativeCap: number,
  exploration: { id: string; budget_usd: number } | undefined,
  day: string,
  at: string,
): Scope[] {
  const spentFrom = `SELECT COALESCE(SUM(w.spent_usd), 0) AS n FROM windows w
    LEFT JOIN initiatives i ON i.id = w.initiative_id WHERE substr(w.started, 1, 10) = ?`;
  const heldFrom = `SELECT COALESCE(SUM(reserved_usd), 0) AS n FROM window_reservations
    WHERE day = ? AND expires_at > ?`;
  const dayScope = (
    scope: ReservationScope,
    cap: number | undefined,
    spentWhere: string,
    heldWhere: string,
    arg: unknown[],
  ): Scope => ({
    scope,
    cap,
    spent: [`${spentFrom}${spentWhere}`, day, ...arg],
    held: [`${heldFrom}${heldWhere}`, day, at, ...arg],
  });
  return [
    dayScope('initiative', initiativeCap, ' AND w.initiative_id = ?', ' AND initiative_id = ?', [
      r.initiativeId,
    ]),
    dayScope(
      'personality',
      r.caps.personalityUsd,
      ' AND i.personality_id = ?',
      ' AND personality_id = ?',
      [r.personalityId],
    ),
    dayScope('global', r.caps.globalUsd, '', '', []),
    dayScope(
      'pool',
      r.origin === 'agent' ? r.caps.poolUsd : undefined,
      " AND i.origin = 'agent'",
      ' AND pool = 1',
      [],
    ),
    // An exploring window also draws on its exploration's own budget, which two processes share.
    // Its spend is lifetime, not per day. A brief window spends the reserve kept for it, not the
    // exploration's budget, so it passes no exploration here.
    {
      scope: 'exploration',
      cap: exploration?.budget_usd,
      spent: ['SELECT spent_usd AS n FROM explorations WHERE id = ?', exploration?.id],
      held: [
        `SELECT COALESCE(SUM(reserved_usd), 0) AS n FROM window_reservations
          WHERE expires_at > ? AND exploration_id = ?`,
        at,
        exploration?.id,
      ],
    },
  ];
}

const HOLDER_PID = /^pid:(\d+)$/;

/**
 * A holder is `pid:N`. A hold whose process no longer exists on this host (a Ctrl-C or kill the
 * runner never saw) is dropped now instead of waiting out its TTL. Pinned by reservations.test.ts,
 * 'a hold whose process is gone is pruned'.
 */
function pruneDeadHolders(db: Database.Database, isPidAlive: (pid: number) => boolean): void {
  const holders = db.prepare('SELECT DISTINCT holder FROM window_reservations').all() as Array<{
    holder: string;
  }>;
  const drop = db.prepare('DELETE FROM window_reservations WHERE holder = ?');
  for (const { holder } of holders) {
    const pid = HOLDER_PID.exec(holder)?.[1];
    if (pid !== undefined && !isPidAlive(Number(pid))) drop.run(holder);
  }
}

/** Call only inside a `BEGIN IMMEDIATE` transaction. `windowId` is minted by the caller. */
export function reserveWindow(
  db: Database.Database,
  r: WindowReservationRequest,
  input: {
    windowId: string;
    initiativeCap: number;
    nowMs: number;
    holder: string;
    isPidAlive: (pid: number) => boolean;
  },
): WindowReservationResult | null {
  const at = new Date(input.nowMs).toISOString();
  const day = at.slice(0, 10);
  // Dead reservations are dropped, never counted.
  db.prepare('DELETE FROM window_reservations WHERE expires_at <= ?').run(at);
  pruneDeadHolders(db, input.isPidAlive);
  if (r.reserveUsd > 0) {
    const exploration =
      r.kind === 'window' && r.explorationId
        ? (db
            .prepare('SELECT id, budget_usd FROM explorations WHERE id = ?')
            .get(r.explorationId) as { id: string; budget_usd: number } | undefined)
        : undefined;
    for (const s of scopes(r, input.initiativeCap, exploration, day, at)) {
      if (s.cap === undefined) continue;
      const spent = db.prepare(s.spent[0]).get(...s.spent.slice(1)) as { n: number };
      const held = db.prepare(s.held[0]).get(...s.held.slice(1)) as { n: number };
      const left = s.cap - spent.n - held.n;
      if (left + EPSILON < r.reserveUsd)
        return { ok: false, scope: s.scope, leftUsd: Math.max(0, left) };
    }
  }
  db.prepare(
    `INSERT INTO window_reservations (window_id, initiative_id, personality_id, pool, day,
       reserved_usd, holder, created_at, expires_at, exploration_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.windowId,
    r.initiativeId,
    r.personalityId,
    r.origin === 'agent' ? 1 : 0,
    day,
    Math.max(0, r.reserveUsd),
    input.holder,
    at,
    new Date(input.nowMs + r.ttlMs).toISOString(),
    r.kind === 'window' ? r.explorationId : null,
  );
  return null;
}

/** Same transaction as the window's close: the spend is on the row, so the hold goes. */
export function releaseWindow(db: Database.Database, windowId: string): void {
  db.prepare('DELETE FROM window_reservations WHERE window_id = ?').run(windowId);
}

/**
 * Heartbeat: a window still running pushes its expiry out to `nowMs + ttlMs`, so the TTL only
 * ever frees the hold of a process that stopped beating. Pinned by __tests__/reservations.test.ts.
 */
export function touchWindow(
  db: Database.Database,
  windowId: string,
  nowMs: number,
  ttlMs: number,
): void {
  db.prepare('UPDATE window_reservations SET expires_at = ? WHERE window_id = ?').run(
    new Date(nowMs + ttlMs).toISOString(),
    windowId,
  );
}
