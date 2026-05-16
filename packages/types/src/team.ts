// @ethosagent/types — team manifest interfaces
// Keep this file zero-dep and side-effect-free.

export type DispatchMode = 'coordinator' | 'self-routing' | 'broadcast';

export type AutonomyTier = 'probationary' | 'standard' | 'trusted';

export interface TrustPolicy {
  mode: 'flat' | 'tiered';
  thresholds?: {
    standard_min_completed?: number;
    standard_min_ratio?: number;
    trusted_min_completed?: number;
    trusted_min_ratio?: number;
  };
}

export type TeamMemberRole = 'coordinator' | 'member';

export interface TeamMember {
  /** Personality id to boot for this slot. */
  personality: string;
  /** TCP port this member listens on. Omit to let the supervisor auto-allocate. */
  port?: number;
  /** Per-member capability labels; overrides what the personality declares in its own config. */
  capabilities?: string[];
  /** When true, the supervisor restarts this member on crash (with exponential back-off). */
  auto_restart?: boolean;
  /**
   * Team-relative role. Drives the Plan B kanban role-gate hook. Defaults to `member`.
   * `dispatch_mode: coordinator` teams must declare exactly one member with `role: coordinator`
   * whose `personality` matches the `coordinator` field.
   */
  role?: TeamMemberRole;
}

export interface TeamManifest {
  /** Unique team identifier; also the default mesh name. */
  name: string;
  /** Plain-English description of what this team (and its mesh) is for. */
  description: string;
  /** High-level capability labels for the mesh as a whole. */
  domain_capabilities: string[];
  /** How work submitted to the mesh is dispatched internally. Defaults to 'coordinator' when `coordinator` field is set, else 'self-routing'. */
  dispatch_mode?: DispatchMode;
  /** The personality that acts as the leader when dispatch_mode is 'coordinator'. Required iff dispatch_mode is 'coordinator'. */
  coordinator?: string;
  /** Model override for the coordinator. Beats global config; global modelRouting is not consulted for the coordinator. */
  coordinator_model?: string;
  /**
   * Per-member personality model overrides.
   * Maps personality ID → model ID. Beats globalModelRouting for that personality;
   * falls through to globalModelRouting if absent, then to global model.
   */
  personality_models?: Record<string, string>;
  /** Which mesh this team joins. Defaults to the team's name (isolated mesh per team). */
  mesh?: string;
  /**
   * Opt-in dispatch preference. When true, the dispatcher uses each assignee's
   * success ratio (`tickets_completed / (completed + failed + orphaned)`, from
   * the board's `team_member_stats`) as a tie-breaker *within the same
   * priority* — higher-success assignees dispatch first. Never an exclusion:
   * every ready+assigned task is still dispatched, and priority always
   * dominates. Defaults to false.
   */
  dispatch_prefer_reliable?: boolean;
  /** Agents to boot as part of this team. */
  members: TeamMember[];
  /** When true, bounced tickets produce structured postmortem entries in team memory. Default: true for multi-member teams. */
  postmortems?: boolean;
  /** Reputation-aware autonomy tiers. When mode is 'tiered', agents earn higher retry budgets and can skip optional gates based on their success ratio. */
  trust_policy?: TrustPolicy;
  /** Plan B — kanban dispatcher tuning. Optional; all fields have sane defaults. */
  kanban?: {
    /**
     * Milliseconds a task can run without a heartbeat before the dispatcher
     * marks it `blocked` ("stalled — no heartbeat"). Default: 90000.
     */
    stale_ms?: number;
    /**
     * Dispatcher polling cadence in ms. Default: 1000. The in-process event
     * bus makes this mostly a fallback for cross-process board mutations.
     */
    poll_ms?: number;
    /**
     * Milliseconds a `running` task can go without activity (its `updated_at`,
     * which `kanban_heartbeat` bumps) before the dispatcher reclaims it back to
     * `ready` for another attempt. Distinct from `stale_ms`, which blocks
     * heartbeat-stale runs; this one re-queues them. Default: 300000.
     */
    staleness_threshold_ms?: number;
  };
}
