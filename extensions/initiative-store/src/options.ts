export interface SQLiteInitiativeStoreOptions {
  /** Clock in epoch ms; tests inject it. */
  now?: () => number;
  /**
   * The operator's daily cap for an initiative, in USD. The store does not know
   * config; wiring binds this to the clamped config value. Defaults to 0.
   */
  capFor?: (initiativeId: string) => number;
  /** `usd_per_exploration` per initiative; a proposal's budget is clamped to it. Unset = no clamp. */
  explorationCapFor?: (initiativeId: string) => number;
  /** This process's id, written as the reservation holder (`pid:N`). Defaults to `process.pid`. */
  processId?: number;
  /** Whether a process still exists on this host; a reservation held by a dead one is pruned. Tests inject it. */
  isPidAlive?: (pid: number) => boolean;
}
