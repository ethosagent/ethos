// @ethosagent/types — team manifest interfaces
// Keep this file zero-dep and side-effect-free.

export type DispatchMode = 'coordinator' | 'self-routing' | 'broadcast';

export interface TeamMember {
  /** Personality id to boot for this slot. */
  personality: string;
  /** TCP port this member listens on. Omit to let the supervisor auto-allocate. */
  port?: number;
  /** Per-member capability labels; overrides what the personality declares in its own config. */
  capabilities?: string[];
  /** When true, the supervisor restarts this member on crash (with exponential back-off). */
  auto_restart?: boolean;
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
  /** Agents to boot as part of this team. */
  members: TeamMember[];
}
