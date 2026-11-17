/**
 * Background sub-agent job config (`background:` section). All fields optional;
 * omitted values fall back to the defaults in `backgroundDefaults()`. Lives in
 * ~/.ethos/config.yaml, NOT on PersonalityConfig (frozen schema).
 *
 * Distinct from the FW-13 `backgroundMaxConcurrent` scalar (config key
 * `background.max_concurrent`) — that governs interactive background sessions;
 * this section governs the Background Sub-Agents job pool.
 */
export interface BackgroundConfig {
  /** Master switch. Default resolved by the wiring layer per surface, not here. */
  enabled?: boolean;
  /** Separate concurrency pool size for background jobs (additive to interactive). Default 2. */
  maxConcurrentJobs?: number;
  /** Max simultaneous active (queued|running) jobs per root session. Default 3. */
  maxJobsPerRoot?: number;
  /** Max simultaneous active jobs per personality. Default 5. */
  maxJobsPerPersonality?: number;
  /** Default per-job cost cap in USD when the tool call omits max_cost_usd. Default 1.00. */
  defaultMaxCostUsd?: number;
  /** Finite-by-default aggregate background spend cap per root, summed over rootSessionKey. Default 5.00. */
  maxRootBackgroundUsd?: number;
  /** Queued rows older than this at boot are expired (ms). Default 900000 (15 min). */
  queuedTtlMs?: number;
  /** Heartbeat staleness threshold (ms). Default 90000 (90s = 3 missed 30s beats). */
  staleMs?: number;
  /** Executor per-job heartbeat timer interval (ms). Default 30000. */
  heartbeatMs?: number;
  /** Terminal-row retention before GC (days). Default 30. */
  retentionDays?: number;
  /**
   * The Pi job runner (`@ethosagent/execution-pi`). Registered ONLY when
   * `image` is set: the host runs inside a container built from it, and there
   * is no sane default to guess — the reference must be digest-pinned, which
   * makes it a per-deployment fact. Absent means `delegate_task(runner: 'pi')`
   * answers `not_available`, which is the honest state of a machine that never
   * built the image.
   */
  pi?: {
    /** Digest-pinned image (`@sha256:`) with `pi` on PATH. See the package's docker/Dockerfile. */
    image: string;
    /** Container memory ceiling in MB. Default 2048 — a coding agent, not a shell. */
    memoryMb?: number;
    /** Host directory holding Pi's `auth.json`. Default `~/.pi/agent`. */
    configDir?: string;
  };
  /**
   * Real ACP-native coding-agent CLIs (`@ethosagent/execution-coding-agents`),
   * keyed by the id each entry registers its OWN `JobRunner` under
   * (`runner: 'claude'`, `runner: 'gemini'`, ...) — see
   * plan/phases/acp-job-runner.md's "Config shape". Each entry needs its own
   * digest-pinned `image`, same posture and reason as `pi.image` (D-ACP4): a
   * bare tag does not satisfy D4's containment claim.
   */
  acp?: {
    agents: Record<
      string,
      {
        /** The ACP agent binary to exec inside the container. */
        command: string;
        /** Args after `command`. Defaults to none. */
        args?: string[];
        /** Digest-pinned image (`@sha256:`) with `command` reachable inside it. */
        image: string;
      }
    >;
  };
}

/**
 * Canonical defaults for the `background:` section. `enabled` defaults to false;
 * the wiring layer may override per surface. All other fields are finite.
 */
export function backgroundDefaults(): Required<Omit<BackgroundConfig, 'enabled' | 'pi' | 'acp'>> & {
  enabled: boolean;
} {
  return {
    enabled: false,
    maxConcurrentJobs: 2,
    maxJobsPerRoot: 3,
    maxJobsPerPersonality: 5,
    defaultMaxCostUsd: 1.0,
    maxRootBackgroundUsd: 5.0,
    queuedTtlMs: 900_000,
    staleMs: 90_000,
    heartbeatMs: 30_000,
    retentionDays: 30,
  };
}

/**
 * Cron trigger surface (`cron:` section,
 * plan/phases/cron-fire-url-collapse.md). One presence-gated switch:
 * `cron.fireUrl` present means external mode (no in-process interval;
 * something outside the process drives `POST /cron/fire`), absent means local
 * mode (today's in-process `setInterval`). There is no third state, and in
 * particular no way to configure "nothing fires anything."
 *
 * Defaults are applied by the wiring layer (`@ethosagent/cron`'s
 * `buildCronTriggers`), not here — an absent `cron:` section means "use
 * today's behavior", i.e. local mode.
 */
export interface CronTopLevelConfig {
  /**
   * URL an external scheduler is expected to reach `POST /cron/fire` on.
   * Present → external mode; absent → local mode. Config key:
   *   cron.fireUrl: https://agent.example.com/cron/fire
   * Overridden by the `ETHOS_CRON_FIRE_URL` environment variable.
   *
   * WHY A URL AND NOT A BOOLEAN. Nothing reads this value today — no code path
   * fetches it, `NoopArmingBackend` is inert, and `HttpFireTrigger` is called
   * *by* the route rather than calling out. So it looks like a boolean wearing
   * a string, and the obvious "simplification" is `cron.external: true`. Do not
   * make it. First, it is the exact field a real `CronArmingBackend` will need
   * — the address it calls back on — so the boolean would have to be replaced
   * by this field later, breaking every operator's config at that point.
   * Second, it documents, in the file where an operator actually looks, WHERE
   * the external scheduler is expected to reach this process; a boolean
   * destroys that information. (plan/phases/cron-fire-url-collapse.md, N1.)
   */
  fireUrl?: string;
  /**
   * Cap on cron jobs executing at once across overlapping ticks. A due job
   * reached while the cap is met is left unclaimed and fires on a later tick.
   * Positive integer; absent = no cap (today's behavior). Config key:
   *   cron.maxParallelJobs: 2
   */
  maxParallelJobs?: number;
  /**
   * Wall-clock cap, in ms, on a cron prompt job's agent turn when the job sets
   * no `maxRunMs` of its own. Positive integer; absent = the scheduler's
   * `DEFAULT_CRON_MAX_RUN_MS` (30 min). Enforced by `CronScheduler.runTurnCapped`
   * in `@ethosagent/cron`. Config key:
   *   cron.defaultMaxRunMs: 600000
   */
  defaultMaxRunMs?: number;
}

/**
 * Parse the `background:` section from the shared `background.*` flat-key bag.
 * Only recognised Background Sub-Agents fields are picked — the FW-13
 * `background.max_concurrent` key belongs to `backgroundMaxConcurrent` and is
 * handled separately. Returns undefined when no recognised field is present so
 * `config.background` is only set when the section actually appears.
 *
 * `default_max_cost_usd` / `max_root_background_usd` may legitimately be the
 * literal `null` meaning "explicit opt-out / unbounded". At this config layer we
 * only parse finite numbers — a `null` (or any non-finite value) leaves the
 * field undefined; the wiring layer distinguishes absence from a tool-level
 * explicit null.
 */
export function buildBackgroundConfig(
  kv: Record<string, string>,
  acpAgentsKv: Record<string, Record<string, string>>,
): BackgroundConfig | undefined {
  const cfg: BackgroundConfig = {};
  if (kv.enabled !== undefined) cfg.enabled = kv.enabled === 'true';
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const maxConcurrentJobs = num(kv.max_concurrent_jobs);
  if (maxConcurrentJobs !== undefined) cfg.maxConcurrentJobs = maxConcurrentJobs;
  const maxJobsPerRoot = num(kv.max_jobs_per_root);
  if (maxJobsPerRoot !== undefined) cfg.maxJobsPerRoot = maxJobsPerRoot;
  const maxJobsPerPersonality = num(kv.max_jobs_per_personality);
  if (maxJobsPerPersonality !== undefined) cfg.maxJobsPerPersonality = maxJobsPerPersonality;
  const defaultMaxCostUsd = num(kv.default_max_cost_usd);
  if (defaultMaxCostUsd !== undefined) cfg.defaultMaxCostUsd = defaultMaxCostUsd;
  const maxRootBackgroundUsd = num(kv.max_root_background_usd);
  if (maxRootBackgroundUsd !== undefined) cfg.maxRootBackgroundUsd = maxRootBackgroundUsd;
  const queuedTtlMs = num(kv.queued_ttl_ms);
  if (queuedTtlMs !== undefined) cfg.queuedTtlMs = queuedTtlMs;
  const staleMs = num(kv.stale_ms);
  if (staleMs !== undefined) cfg.staleMs = staleMs;
  const heartbeatMs = num(kv.heartbeat_ms);
  if (heartbeatMs !== undefined) cfg.heartbeatMs = heartbeatMs;
  const retentionDays = num(kv.retention_days);
  if (retentionDays !== undefined) cfg.retentionDays = retentionDays;
  // `pi_image` is the switch: no image, no Pi runner (see `BackgroundConfig.pi`).
  if (kv.pi_image) {
    const memoryMb = num(kv.pi_memory_mb);
    cfg.pi = {
      image: kv.pi_image,
      ...(memoryMb !== undefined ? { memoryMb } : {}),
      ...(kv.pi_config_dir ? { configDir: kv.pi_config_dir } : {}),
    };
  }
  // `background.acp.agents.<name>.{command,args,image}` — each entry needs
  // both `command` and `image` to be usable; an incomplete entry is dropped
  // rather than half-built, same discipline the voice provider roster uses
  // for a missing `provider` field.
  const acpAgents: Record<string, { command: string; args?: string[]; image: string }> = {};
  for (const [name, fields] of Object.entries(acpAgentsKv)) {
    if (!fields.command || !fields.image) continue;
    const args = fields.args
      ? fields.args
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    acpAgents[name] = {
      command: fields.command,
      ...(args && args.length > 0 ? { args } : {}),
      image: fields.image,
    };
  }
  if (Object.keys(acpAgents).length > 0) cfg.acp = { agents: acpAgents };
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

/** Largest `cron.defaultMaxRunMs` a Node timer can hold (2^31-1 ms). */
const CRON_MAX_RUN_MS_CEILING = 2_147_483_647;

/**
 * Parse the `cron:` section from its flat-key bag (see `CronTopLevelConfig`).
 * Returns undefined when no recognised field is present so `config.cron` is
 * only set when the section actually appears — an absent section means
 * "today's behavior, unchanged".
 *
 * The removed `cron.trigger.*` / `cron.arming.*` keys are no longer read; a
 * leftover line surfaces through the generic `has no effect` notice from
 * {@link ConfigKeyUse} and is preserved by `writeConfig`.
 */
export function buildCronConfig(
  kv: Record<string, string>,
  deprecations: string[],
): CronTopLevelConfig | undefined {
  const cfg: CronTopLevelConfig = {};

  if (kv.fireUrl !== undefined) cfg.fireUrl = kv.fireUrl;
  // Positive integer only — `0` would mean "never fire anything", which is a
  // typo rather than a setting, so it is dropped along with negatives.
  const maxParallel = Number(kv.maxParallelJobs);
  if (kv.maxParallelJobs !== undefined && Number.isFinite(maxParallel) && maxParallel > 0) {
    cfg.maxParallelJobs = Math.floor(maxParallel);
  }
  const maxRunMs = Number(kv.defaultMaxRunMs);
  if (kv.defaultMaxRunMs !== undefined && Number.isFinite(maxRunMs) && maxRunMs >= 1) {
    // Above 2^31-1 Node clamps the run's setTimeout to 1ms, so every cron run
    // would time out at once. Mirrors `MAX_CRON_RUN_MS` in `@ethosagent/cron`,
    // which `CronScheduler.runTurnCapped` also clamps to. Pinned by
    // `__tests__/config-cron-max-run.test.ts`.
    if (maxRunMs > CRON_MAX_RUN_MS_CEILING) {
      deprecations.push(
        `cron.defaultMaxRunMs: ${kv.defaultMaxRunMs} is above the maximum of ${CRON_MAX_RUN_MS_CEILING} (about 24.8 days) and was ignored; the built-in default applies.`,
      );
    } else {
      cfg.defaultMaxRunMs = Math.floor(maxRunMs);
    }
  }
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

/**
 * Serialize the `background:` section to flat `[key, value]` pairs, emitting
 * only fields actually present on the config so parse→serialize→parse round-
 * trips are stable (absent fields fall back to `backgroundDefaults()`, never
 * written out).
 */
export function backgroundToLines(bg: BackgroundConfig): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  if (bg.enabled !== undefined) lines.push(['enabled', String(bg.enabled)]);
  if (bg.maxConcurrentJobs !== undefined)
    lines.push(['max_concurrent_jobs', String(bg.maxConcurrentJobs)]);
  if (bg.maxJobsPerRoot !== undefined) lines.push(['max_jobs_per_root', String(bg.maxJobsPerRoot)]);
  if (bg.maxJobsPerPersonality !== undefined)
    lines.push(['max_jobs_per_personality', String(bg.maxJobsPerPersonality)]);
  if (bg.defaultMaxCostUsd !== undefined)
    lines.push(['default_max_cost_usd', String(bg.defaultMaxCostUsd)]);
  if (bg.maxRootBackgroundUsd !== undefined)
    lines.push(['max_root_background_usd', String(bg.maxRootBackgroundUsd)]);
  if (bg.queuedTtlMs !== undefined) lines.push(['queued_ttl_ms', String(bg.queuedTtlMs)]);
  if (bg.staleMs !== undefined) lines.push(['stale_ms', String(bg.staleMs)]);
  if (bg.heartbeatMs !== undefined) lines.push(['heartbeat_ms', String(bg.heartbeatMs)]);
  if (bg.retentionDays !== undefined) lines.push(['retention_days', String(bg.retentionDays)]);
  return lines;
}
