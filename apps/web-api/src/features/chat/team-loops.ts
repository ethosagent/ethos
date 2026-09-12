import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { NotificationRouter } from '@ethosagent/types';
import type { GoalsBackend } from '../../services/goals.service';

// Team-scoped loops for the web chat surface (plan/phases/teams-as-a-scope.md
// D4, §9). A personality that belongs to a team runs on that team's loop —
// team board, `team_memory_*` tools, role gate, postmortems, `ctx.teamId` —
// whichever URL the browser reached it from. The loop IS the scope; this
// registry is the per-team loop map `ChatService` resolves against.
//
// web-api never composes a loop itself (ARCHITECTURE.md Law 5): the
// composition root (`ethos serve`) injects `factory`, the same way it injects
// the main `loop`. Loops are built lazily, memoised per team and single-flight,
// because each one carries its own tool registry, MCP clients and plugin
// loader (plan Risks — "team loops double the loop count per team").

export interface TeamLoopHandle {
  loop: AgentLoop;
  /**
   * The team loop's goal store + executor. A goal for a team personality
   * belongs on the team's runner for the same reason its chat turn does — the
   * team board, `team_memory_*`, the role gate and `ctx.teamId` all come from
   * that loop. Absent → goals for its members stay on the main pair.
   */
  goals?: GoalsBackend;
  /** Reload the loop's personality registry before a turn, as the main loop does. */
  refreshPersonalities?: () => Promise<void>;
  /** The loop's own notification router, so plugin monitors reach the web session. */
  notificationRouter?: NotificationRouter;
  dispose?: () => Promise<void>;
}

export interface TeamMembership {
  name: string;
  members: string[];
  coordinator: string | null;
}

export interface TeamLoopRegistryOptions {
  factory: (teamName: string) => Promise<TeamLoopHandle>;
  /** Membership source, in manifest order. Reused from the teams read model. */
  listTeams: () => Promise<TeamMembership[]>;
  /**
   * The team the MAIN loop already runs as (`ethos serve --team <name>`). Its
   * members resolve to no team here so they stay on the main loop, which is
   * that team's loop already.
   */
  mainLoopTeam?: string;
  /** Called once per built loop — the surface wires its per-loop hooks here. */
  onCreate?: (teamName: string, handle: TeamLoopHandle) => void;
  /** Membership cache lifetime. Default 5s. */
  membershipTtlMs?: number;
  now?: () => number;
}

const DEFAULT_MEMBERSHIP_TTL_MS = 5_000;

export class TeamLoopRegistry {
  private readonly loops = new Map<string, Promise<TeamLoopHandle>>();
  private membership: TeamMembership[] | null = null;
  private membershipFetchedAt = 0;
  private membershipInFlight: Promise<TeamMembership[]> | null = null;
  /** Set by `disposeAll`: the owning surface is gone, so nothing is built again. */
  private disposed = false;

  constructor(private readonly opts: TeamLoopRegistryOptions) {}

  /**
   * The team a personality belongs to — the first team in manifest order that
   * lists it as a member or coordinator — or null when it is independent (or
   * belongs to `mainLoopTeam`).
   */
  async teamFor(personalityId: string): Promise<string | null> {
    const teams = await this.loadMembership();
    for (const team of teams) {
      if (team.name === this.opts.mainLoopTeam) continue;
      if (team.coordinator === personalityId || team.members.includes(personalityId)) {
        return team.name;
      }
    }
    return null;
  }

  /** `teamFor` + `loopFor` in one step: the handle a personality's turns run on, or null. */
  async handleFor(personalityId: string): Promise<TeamLoopHandle | null> {
    const teamName = await this.teamFor(personalityId);
    return teamName === null ? null : this.loopFor(teamName);
  }

  /** Lazily build (once) and return the team's loop. Concurrent callers share one build. */
  loopFor(teamName: string): Promise<TeamLoopHandle> {
    if (this.disposed) {
      return Promise.reject(new Error(`team loop "${teamName}" requested after dispose`));
    }
    const existing = this.loops.get(teamName);
    if (existing) return existing;
    const building = this.opts
      .factory(teamName)
      .then(async (handle) => {
        try {
          this.opts.onCreate?.(teamName, handle);
        } catch (err) {
          // F06 — `onCreate` throws when the surface was disposed while this
          // build was in flight. The handle would be lost (the slot is dropped
          // below, and `disposeAll` only disposes handles that resolved), so
          // release its runtime here.
          await handle.dispose?.();
          throw err;
        }
        return handle;
      })
      .catch((err) => {
        // A failed build must not poison the slot — the next turn retries.
        this.loops.delete(teamName);
        throw err;
      });
    this.loops.set(teamName, building);
    return building;
  }

  /** Drop the membership cache so the next `teamFor` re-reads the manifests. */
  invalidate(): void {
    this.membership = null;
    this.membershipFetchedAt = 0;
  }

  /** Dispose every built (and in-flight) team loop. Terminal: the owning
   *  surface's shutdown, so `loopFor` refuses afterwards. Pinned by
   *  `__tests__/team-loops.test.ts`. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    const pending = [...this.loops.values()];
    this.loops.clear();
    await Promise.allSettled(
      pending.map(async (p) => {
        const handle = await p;
        await handle.dispose?.();
      }),
    );
  }

  private loadMembership(): Promise<TeamMembership[]> {
    const now = this.opts.now?.() ?? Date.now();
    const ttl = this.opts.membershipTtlMs ?? DEFAULT_MEMBERSHIP_TTL_MS;
    if (this.membership !== null && now - this.membershipFetchedAt < ttl) {
      return Promise.resolve(this.membership);
    }
    if (this.membershipInFlight) return this.membershipInFlight;
    this.membershipInFlight = this.opts
      .listTeams()
      .then((teams) => {
        this.membership = teams;
        this.membershipFetchedAt = this.opts.now?.() ?? Date.now();
        return teams;
      })
      .finally(() => {
        this.membershipInFlight = null;
      });
    return this.membershipInFlight;
  }
}

/**
 * Drive a turn on a loop that is still being resolved. The voice lanes hand
 * their turn driver a synchronous `run()` returning an `AsyncGenerator`, so
 * the loop lookup (`TeamLoopRegistry.handleFor`) is awaited inside the
 * generator rather than before it.
 */
export async function* runOnLoop(
  loop: Promise<AgentLoop>,
  run: (loop: AgentLoop) => AsyncIterable<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  yield* await loop.then(run);
}
