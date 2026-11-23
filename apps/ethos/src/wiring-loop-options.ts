import type { WiringProfile } from '@ethosagent/wiring';

/**
 * Options for `createAgentLoop` (`./wiring`). Extracted so the factory's signature stays
 * readable; the shape is unchanged.
 */
export interface EthosLoopOptions {
  profile?: WiringProfile;
  meshRegistryPath?: string;
  /**
   * Shared CronScheduler so the agent-callable `cron` tool lands in the
   * same store the operator-driven `ethos cron` CLI uses. Pass the
   * gateway's / serve's scheduler instance here; the wiring layer
   * registers the tool only when the personality opts in via
   * `toolset.yaml`. Omit for ephemeral CLI chat sessions where
   * scheduled work can't persist past process exit.
   */
  cronScheduler?: import('@ethosagent/cron').CronScheduler;
  /**
   * Shared WatcherManager so the agent-callable `watcher_*` tools land
   * in the same watchers.json the ticking manager reads. Pass the
   * gateway's / serve's manager instance; omit for ephemeral CLI chat
   * sessions where a watcher couldn't tick past process exit.
   */
  watcherManager?: import('@ethosagent/watchers').WatcherManager;
  /**
   * Shared call log so the outbound `call` tool records the calls this loop
   * places. Gateway only — it is the surface that opens `~/.ethos/calls.db`
   * for inbound dispatch, and both directions belong in the one file. Omit
   * and `call` dials without writing a row.
   */
  callLog?: import('@ethosagent/call-log').CallLog;
  /**
   * App-layer slash command registry (chat REPL). Threaded through to
   * plugin loading so plugin-registered slash commands show up in
   * autocomplete and /help.
   */
  slashRegistry?: import('@ethosagent/wiring').WiringSlashRegistry;
  /**
   * The bot this loop answers as, stamped on background jobs it spawns so a
   * completion stays routable back to its lane across a restart. Gateway
   * only — one loop per bot; CLI/serve loops have no bot identity.
   */
  originBotKey?: string;
  /** Stable host label for a loop with no bot identity; see `CreateAgentLoopOptions.jobAffinity`. */
  jobAffinity?: string;
  /**
   * Resolve which thread a live turn belongs to, for the same reason.
   * Gateway only — it is the one component that knows the mapping.
   */
  resolveOriginThreadId?: (sessionKey: string) => string | undefined;
  /** Resolve who started a live turn, for the same reason. Gateway only. */
  resolveOriginUserId?: (sessionKey: string) => string | undefined;
  /** The bot daily cap's background gate (`Gateway.backgroundGate`). Gateway only. */
  backgroundGate?: import('@ethosagent/types').UsageGate;
  /**
   * Lane 0 (D16) — force a LIVE served-window probe (bypassing the disk
   * cache) and rewrite the cache. Set by `ethos bench context`; chat and
   * gateway startup leave it unset and ride the cache.
   */
  probeWindowRefresh?: boolean;
  /**
   * Native LiveKit MEDIA binding from `resolveLiveKitMedia()` — the thing
   * that lets `voiceStack.createSipAdapter` exist and a phone call carry
   * audio. Gateway only, and only when `voice.trunk`/`voice.livekit` is
   * configured; every other caller omits it and gets today's behaviour.
   */
  livekit?: import('@ethosagent/wiring').LiveKitBindings;
  /**
   * The approval outbox — what makes `outbound_policy.approve_before_send`
   * real for this loop's `send_message` and `watcher_create` (O-T3/O-T12,
   * plan/phases/trust-before-reach.md). Build it with `createOutboxRuntime`
   * (`./lib/outbox-wiring`) and pass `runtime.wiring`.
   *
   * Gateway roles only: queueing a publication is worth nothing on a surface
   * with no adapter to publish it through later, and the dispatcher that
   * delivers approved items runs in the gateway process. Omitted everywhere
   * else, and both tools behave exactly as they did before Part 2.
   */
  outbox?: import('@ethosagent/wiring').OutboxWiring;
  /**
   * Pin the working directory tools resolve relative paths against, instead
   * of `process.cwd()`.
   *
   * One caller: `ethos mcp serve --personality <id>` (M-D11,
   * plan/phases/trust-before-reach.md Part 3). That process is spawned BY an
   * MCP client whose working directory is arbitrary — Claude Desktop's is
   * whatever the OS handed the app — so the launch directory is not a reach
   * anyone chose. Every other command runs where the operator typed it and
   * leaves this unset.
   */
  workingDir?: string;
  /**
   * Turn off the post-turn learners (M-D6) — see
   * `CreateAgentLoopOptions.disablePostTurnLearning` for what that means and
   * why it is a security property rather than a preference. Set by any host
   * that lets someone other than the operator start a turn; the MCP export is
   * the first.
   */
  disablePostTurnLearning?: boolean;
}
