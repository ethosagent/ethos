/** The job-affinity half of `CreateAgentLoopOptions`; see `resolveJobAffinity`. */
export interface JobAffinityOptions {
  /**
   * A stable host label for a loop with no bot identity — `serve`, `boot`,
   * `gateway`. A bot key (`originBotKey`) always wins. Absent: the loop gets a
   * pid affinity, which never auto-resumes a job (durable-background-jobs D6).
   */
  jobAffinity?: string;
}

/**
 * The executor `affinity` for a loop, and `resumeAffinity` — the same value,
 * present only when it survives a process restart (only then may a run be
 * auto-resumed).
 *
 * F06 — who inherits this executor's queued rows when its loop is disposed. A
 * bot's loop: any loop answering as the same bot — the replacement after a live
 * bot edit, or the next boot's. A loop with no bot identity: only a successor in
 * THIS process (desktop restart, a chat model switch) — `ethos chat`, `ethos
 * serve` and `ethos gateway`'s system loop may share one jobs.db, and none may
 * run another's jobs. A host label (`host:<name>`) is namespaced so it cannot
 * collide with a bot key a user happened to name `serve`.
 *
 * `profile` is the `WiringProfile` (`cli | tui | web | acp | mcp`). Pinned by
 * `__tests__/job-affinity.test.ts`.
 */
export function resolveJobAffinity(
  profile: string,
  opts: { originBotKey?: string; jobAffinity?: string },
): { affinity: string; resumeAffinity?: string } {
  const stable = opts.originBotKey
    ? `${profile}:${opts.originBotKey}`
    : opts.jobAffinity
      ? `${profile}:host:${opts.jobAffinity}`
      : undefined;
  return stable === undefined
    ? { affinity: `${profile}:pid-${process.pid}` }
    : { affinity: stable, resumeAffinity: stable };
}
