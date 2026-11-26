// Serve-role construction seams, web-API half: the option types of
// `buildServeWebApi`. The function itself stays in ./serve.ts because it calls
// `scriptCallableFor`, `toolsDeclaringNetwork` (`@ethosagent/core`) and
// `computeContextAnatomy` (`@ethosagent/observability-sqlite`), app-to-extension
// value imports that archcheck rule `l5-apps-through-wiring` baselines for
// serve.ts's path and would refuse in a new module. Type-only: no module state.
// `serve.ts` re-exports `BuildServeWebApiOptions`, so its export surface is
// unchanged (apps/ethos/src/__tests__/serve-export-surface.test.ts).

import type { EthosConfig } from '@ethosagent/config';
import type { AgentLoop, DefaultToolRegistry } from '@ethosagent/core';
import type { CronScheduler, CronTriggers } from '@ethosagent/cron';
import type { createMetricsTextProvider } from '@ethosagent/observability-sqlite';
import type { SQLiteContextLog, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import type { FsAttachmentCache } from '@ethosagent/storage-fs';
import type { McpManager } from '@ethosagent/tools-mcp';
import type { IdempotencyStore, RouteModule, TeamLoopHandle } from '@ethosagent/web-api';
import type {
  buildA2aPeeringService,
  createSessionStore,
  IdentityMap,
  SmartApproverDecisionSite,
} from '@ethosagent/wiring';
import type { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';
import type { resolveCorsOrigins } from './serve-helpers';
import type { ServePersonalityRegistry } from './serve-loop';
import type { locateWebDist } from './serve-util';

/** The voice slice `createAgentLoop`/`createTeamAgentLoop` hands back, as
 *  `runServe` holds it and as `buildServeWebApi` below receives it. */
export type ServeVoiceConfig = {
  sttProviderName?: string;
  sttProviderConfig: Record<string, unknown>;
  ttsProviderName?: string;
  ttsProviderConfig: Record<string, unknown>;
  ttsRoster?: Record<string, import('@ethosagent/types').TtsProviderEntry>;
  sttRoster?: Record<string, import('@ethosagent/types').SttProviderEntry>;
  realtimeRoster?: Record<string, import('@ethosagent/types').RealtimeProviderEntry>;
  realtimeDefault?: string;
  tier?: 'pipeline' | 'realtime';
  realtimeSessionBudgetUsd?: number;
  trustedVoicePlugins?: ReadonlySet<string>;
};

export interface BuildServeWebApiOptions {
  config: EthosConfig;
  /** `~/.ethos` (or the `--data-dir` override). */
  dir: string;
  loop: AgentLoop;
  /** `CreateAgentLoopResult.approverDecision` of the build `loop` came from. */
  approverDecision?: SmartApproverDecisionSite;
  /** `CreateAgentLoopResult.executionPostureFor` of the build `loop` came from. */
  executionPostureFor: import('@ethosagent/wiring').CreateAgentLoopResult['executionPostureFor'];
  /** `CreateAgentLoopResult.usageMeter` of the build `loop` came from. */
  usageMeter: Pick<import('@ethosagent/wiring').UsageMeter, 'meter'>;
  session: ReturnType<typeof createSessionStore>;
  contextLog: SQLiteContextLog;
  personalities: ServePersonalityRegistry;
  identityMap: IdentityMap;
  attachmentCache: FsAttachmentCache;
  apiKeys: SqliteApiKeyStore;
  /** Share-links store + bind address (`lib/open-share-links.ts`). */
  shareLinks: import('../lib/open-share-links').ServeShareLinks['host'];
  idempotencyStore: IdempotencyStore;
  /** The concrete registry — the character sheet's `mcpExport` seam resolves
   *  `mcp_export` against it, which needs `toolNamesForPersonality`. */
  toolRegistry: DefaultToolRegistry | undefined;
  mcpManager: McpManager | undefined;
  pluginLoader: import('@ethosagent/plugin-loader').PluginLoader | undefined;
  notificationRouter: import('@ethosagent/types').NotificationRouter | undefined;
  cronScheduler: CronScheduler | null;
  cronTriggers: CronTriggers;
  /** The loop's goal store + executor pair. Undefined → web goal create/resume is refused. */
  goals: import('@ethosagent/wiring').CreateAgentLoopResult['goals'] | undefined;
  /** The loop's memory surfaces (`CreateAgentLoopResult.memoryBundle`) — the
   *  web editor, Timeline, restore and approve queue on its configured backend. */
  memoryBundle: import('@ethosagent/wiring').MemoryBundle;
  /** The loop's self-amendment service (`CreateAgentLoopResult.amendments`).
   *  The web holds only its reads (`AmendmentReader`, D30). */
  amendments: import('@ethosagent/web-api').AmendmentReader;
  jobStore: import('@ethosagent/types').JobStore | undefined;
  jobRunners: import('@ethosagent/types').JobRunnerRegistry | undefined;
  jobControl: import('@ethosagent/wiring').CreateAgentLoopResult['jobControl'] | undefined;
  backgroundExecutor:
    | import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor']
    | undefined;
  setOnSkillProposed: ((fn: (skillId: string, personalityId: string) => void) => void) | undefined;
  onMemoryCaptured:
    | import('@ethosagent/wiring').CreateAgentLoopResult['onMemoryCaptured']
    | undefined;
  refreshLoopPersonalities: (() => Promise<void>) | undefined;
  skillsInjector: import('@ethosagent/skills').SkillsInjector | undefined;
  /**
   * The LOOP's execution-backend registry. Web-api's `ExecutionService` probes
   * `get('ssh')` on it, and because `resolve()` memoises that is the instance
   * `compose-tools` built for the tools — the probe tests what executes.
   * Undefined on the team-coordinator path (`createTeamAgentLoop` exposes no
   * registry) and in onboarding mode: the probe then answers
   * `backend_unresolved` with the reason, never a guessed `unreachable`.
   */
  executionBackends: import('@ethosagent/types').ExecutionBackendRegistry | undefined;
  skillsCatalogDir: ReturnType<typeof resolveSkillsCatalogDir>;
  sttProviders: import('@ethosagent/types').SttProviderRegistry | undefined;
  ttsProviders: import('@ethosagent/types').TtsProviderRegistry | undefined;
  realtimeProviders: import('@ethosagent/types').RealtimeVoiceProviderRegistry | undefined;
  voiceConfig: ServeVoiceConfig | undefined;
  voiceStack: import('@ethosagent/wiring').VoiceStack | undefined;
  titleFn: ((systemPrompt: string, userMessage: string) => Promise<string>) | undefined;
  corsOrigins: ReturnType<typeof resolveCorsOrigins>;
  allowedOrigins: string[] | undefined;
  trustProxy: boolean;
  /** Drives the `Secure` cookie flag together with `config.webBaseUrl`. */
  isLoopbackBind: boolean;
  webDist: ReturnType<typeof locateWebDist>;
  metricsText: ReturnType<typeof createMetricsTextProvider>;
  recordHttpRequest: (method: string, status: number) => void;
  a2aRouteModules: RouteModule[];
  a2aPeering: ReturnType<typeof buildA2aPeeringService>;
  isA2aEnabled: () => boolean;
  setA2aEnabled: (enabled: boolean) => Promise<void>;
  /**
   * Team-scoped loop factory for web chat (teams-as-a-scope D4). Optional so
   * the merged `ethos boot` profile, which does not build team loops, is
   * unchanged.
   */
  createTeamLoop?: (teamName: string) => Promise<TeamLoopHandle>;
  /** `--team <name>` — the team `loop` already runs as; the registry skips it. */
  mainLoopTeam?: string;
}
