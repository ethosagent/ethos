import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { meshRegistryPath, setMeshObservabilityService } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
  startPruneCron,
} from '@ethosagent/observability-sqlite';
import {
  EnvSecretsResolver,
  FileSecretsResolver,
  FsStorage,
  loadDotEnv,
  MergedSecretsResolver,
} from '@ethosagent/storage-fs';
import { parseTeamManifest, teamsDir } from '@ethosagent/team-supervisor';
import type {
  LLMProvider,
  RetentionConfig,
  SecretsResolver,
  Storage,
  TeamManifest,
  ToolRegistry,
} from '@ethosagent/types';
import {
  type CreateAgentLoopResult,
  EthosObservability,
  createAgentLoop as packageCreateAgentLoop,
  createLLM as packageCreateLLM,
  type WiringConfig,
  type WiringProfile,
} from '@ethosagent/wiring';
import { type EthosConfig, ethosDir, readKeys, readRawConfig } from './config';
import { setObservabilityService } from './error-log';
import { logger } from './logger';

// CLI-side adapter over @ethosagent/wiring. Resolves the rotation pool, data
// dir, working dir, and logger from the CLI's environment, then delegates.
// The actual loop assembly (LLM + tools + hooks + session/memory/personalities)
// lives in the package so TUI / web / ACP surfaces can share it.

let storageSingleton: Storage | undefined;

/**
 * The CLI's process-wide Storage instance. FsStorage is stateless so multiple
 * instances would be safe, but a singleton keeps the dependency-injection
 * graph readable: any code path that needs ~/.ethos/ access calls this.
 */
export function getStorage(): Storage {
  if (!storageSingleton) storageSingleton = new FsStorage();
  return storageSingleton;
}

let secretsInitPromise: Promise<SecretsResolver> | undefined;

export function getSecretsResolver(): Promise<SecretsResolver> {
  if (!secretsInitPromise) {
    secretsInitPromise = initSecrets();
  }
  return secretsInitPromise;
}

async function initSecrets(): Promise<SecretsResolver> {
  const envFilePath = process.env.ETHOS_ENV_FILE ?? join(ethosDir(), '.env');
  loadDotEnv(envFilePath);

  const file = new FileSecretsResolver({
    dir: join(ethosDir(), 'secrets'),
    storage: getStorage(),
  });
  const env = new EnvSecretsResolver();

  const rawConfig = await readRawConfig(getStorage());
  if (rawConfig?.aws?.secrets?.enabled) {
    const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
    const awsResolver = new AwsSecretsManagerResolver({
      region: rawConfig.aws.secrets.region ?? 'us-east-1',
      prefix: rawConfig.aws.secrets.prefix ?? 'ethos',
      endpoint: rawConfig.aws.secrets.endpoint,
    });
    return new MergedSecretsResolver({
      readers: [env, awsResolver, file],
      writer: awsResolver,
    });
  }

  return new MergedSecretsResolver({ readers: [env, file], writer: file });
}

let obsSingleton: ObservabilityService | undefined;
let ethosObsSingleton: EthosObservability | undefined;
let pruneStop: (() => void) | undefined;

/**
 * The CLI's process-wide ObservabilityService. Creates the SQLite store and
 * blob store on first access, returning the same instance thereafter. The
 * ethos-flavored adapter is constructed alongside and registered with
 * components that need typed domain helpers (error-log, mesh journal).
 */
export function getObservabilityService(): ObservabilityService {
  if (!obsSingleton) {
    const dir = ethosDir();
    const storage = getStorage();
    const store = new SQLiteObservabilityStore(join(dir, 'observability.db'));
    const blobStore = new BlobStore(join(dir, 'blobs'), storage);
    const killSwitchPath = join(dir, '.observability.disabled');
    obsSingleton = new ObservabilityService(store, blobStore, () => existsSync(killSwitchPath));
    ethosObsSingleton = new EthosObservability(obsSingleton);
    setObservabilityService(ethosObsSingleton);
    setMeshObservabilityService(ethosObsSingleton);
  }
  return obsSingleton;
}

function getEthosObservability(): EthosObservability {
  // Constructed alongside the singleton — getObservabilityService initialises both.
  if (!ethosObsSingleton) {
    getObservabilityService();
  }
  if (!ethosObsSingleton) throw new Error('ethos observability adapter not initialised');
  return ethosObsSingleton;
}

/**
 * Start the nightly observability prune cron job (03:00 local time).
 * Idempotent — calling it more than once is safe; the second call is a no-op.
 * Returns a stop function for clean shutdown.
 */
export function startNightlyPrune(
  config?: RetentionConfig,
  personalitiesConfig?: Record<string, { retention?: RetentionConfig }>,
): () => void {
  if (!pruneStop) {
    const handle = startPruneCron({
      obsDbPath: join(ethosDir(), 'observability.db'),
      sessDbPath: join(ethosDir(), 'sessions.db'),
      config,
      perSubjectConfig: personalitiesConfig,
    });
    pruneStop = handle.stop;
  }
  return pruneStop;
}

/** Stop the nightly prune cron job if it was started. */
export function stopNightlyPrune(): void {
  if (pruneStop) {
    pruneStop();
    pruneStop = undefined;
  }
}

let evolverCronStop: (() => void) | undefined;

/**
 * Register the skill-evolver cron job. Idempotent — second call is a no-op.
 * Returns a stop function.
 *
 * The execution callback lives here (app layer) so the extension stays pure
 * and never references CLI command strings. `runEvolveRun` is imported lazily
 * to avoid pulling better-sqlite3 and the LLM into startup.
 */
export async function startEvolverCron(schedule: string, config: EthosConfig): Promise<() => void> {
  if (!evolverCronStop) {
    const { registerEvolverCron } = await import('@ethosagent/skill-evolver');
    evolverCronStop = registerEvolverCron(schedule, async () => {
      try {
        // Lazy import keeps the LLM wiring out of the startup bundle.
        const { runEvolve } = await import('./commands/evolve');
        await runEvolve(['run', '--quiet'], config);
      } catch (err) {
        // Cron failures must not propagate into the interactive session.
        // Log a warning to stderr so the user can diagnose if they look.
        process.stderr.write(
          `[ethos evolve cron] run failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });
  }
  return evolverCronStop;
}

/** Stop the evolver cron job if it was started. */
export function stopEvolverCron(): void {
  if (evolverCronStop) {
    evolverCronStop();
    evolverCronStop = undefined;
  }
}

async function withRotation(config: EthosConfig) {
  const rotationKeys =
    config.provider === 'anthropic' ? await readKeys(getStorage(), await getSecretsResolver()) : [];
  return { ...config, rotationKeys };
}

export async function createLLM(config: EthosConfig): Promise<LLMProvider> {
  return packageCreateLLM(await withRotation(config));
}

export async function createAgentLoop(
  config: EthosConfig & Pick<WiringConfig, 'teamName' | 'role' | 'postmortems' | 'trustPolicy'>,
  opts: {
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
  } = {},
): Promise<CreateAgentLoopResult> {
  const rotated = await withRotation(config);
  const wiringConfig: WiringConfig = {
    ...rotated,
    ...(config.teamName !== undefined ? { teamName: config.teamName } : {}),
    ...(config.role !== undefined ? { role: config.role } : {}),
    ...(config.auxiliary?.compression
      ? { auxiliaryCompression: config.auxiliary.compression }
      : {}),
    ...(config.auxiliary?.vision ? { auxiliaryVision: config.auxiliary.vision } : {}),
    ...(config.postmortems !== undefined ? { postmortems: config.postmortems } : {}),
    ...(config.trustPolicy !== undefined ? { trustPolicy: config.trustPolicy } : {}),
    ...(config.modelCatalog ? { modelCatalogConfig: config.modelCatalog } : {}),
    ...(config.storage ? { storage: config.storage } : {}),
    secretsResolver: await getSecretsResolver(),
  };
  const result = await packageCreateAgentLoop(wiringConfig, {
    dataDir: ethosDir(),
    workingDir: process.cwd(),
    profile: opts.profile ?? 'cli',
    logger,
    meshRegistryPath: opts.meshRegistryPath,
    observability: getEthosObservability(),
    ...(opts.cronScheduler ? { cronScheduler: opts.cronScheduler } : {}),
  });

  result.setOnSkillProposed?.((skillId, personalityId) => {
    console.warn(
      `[skill-evolution] Proposed skill candidate "${skillId}" for personality "${personalityId}". ` +
        `Review with: ethos evolve --list-pending`,
    );
  });

  return result;
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

export interface TeamLoopInfo {
  loop: AgentLoop;
  toolRegistry: ToolRegistry;
  /** Personality the coordinator runs as. */
  coordinatorPersonality: string;
  /** Mesh name (team name unless manifest.mesh overrides it). */
  meshName: string;
  /** Forward the improvement-fork callback setter so `serve.ts` can wire SSE. */
  setOnSkillProposed?: (fn: (skillId: string, personalityId: string) => void) => void;
}

/** Resolve a team manifest by name (local ./team.yaml or ~/.ethos/teams/<n>.yaml). */
export function loadTeamManifest(teamName: string): TeamManifest {
  // Try trusted location first — ~/.ethos/teams/<teamName>.yaml
  const trusted = join(teamsDir(), `${teamName}.yaml`);
  try {
    return parseTeamManifest(readFileSync(trusted, 'utf-8'));
  } catch {
    // Not found — fall through to CWD fallback
  }
  // Fallback: ./team.yaml in CWD (developer convenience, lower priority)
  const local = resolvePath('./team.yaml');
  const src = readFileSync(local, 'utf-8');
  const m = parseTeamManifest(src);
  if (m.name === teamName) return m;
  throw new Error(`team.yaml in CWD has name "${m.name}", expected "${teamName}"`);
}

/**
 * Build an AgentLoop wired to a team's named mesh.
 * The coordinator personality is taken from manifest.coordinator, falling back
 * to the first member, then to config.personality.
 *
 * Phase 2: applies coordinator model override from manifest.coordinator_model.
 */
export async function createTeamAgentLoop(
  config: EthosConfig,
  teamName: string,
  opts: { profile?: WiringProfile; role?: 'coordinator' | 'member' } = {},
): Promise<TeamLoopInfo> {
  const manifest = loadTeamManifest(teamName);
  const coordinatorPersonality =
    manifest.coordinator ?? manifest.members[0]?.personality ?? config.personality;
  const meshName = manifest.mesh ?? manifest.name;

  // Coordinator model: manifest.coordinator_model beats global config.model.
  // Coordinator does NOT use personality-level modelRouting (see plan doc).
  const coordinatorConfig = manifest.coordinator_model
    ? { ...config, model: manifest.coordinator_model }
    : config;

  // Plan B — thread teamName + role into the wiring so the kanban store points at
  // the team board and the role-gate hook gets registered.
  const { loop, toolRegistry, setOnSkillProposed } = await createAgentLoop(
    {
      ...coordinatorConfig,
      personality: coordinatorPersonality,
      teamName,
      role: opts.role ?? 'coordinator',
      postmortems: manifest.postmortems,
      trustPolicy: manifest.trust_policy,
    },
    { profile: opts.profile ?? 'cli', meshRegistryPath: meshRegistryPath(meshName) },
  );

  const coordinatorSystem = buildCoordinatorTeamPrompt(manifest);
  loop.hooks.registerModifying('before_prompt_build', async (payload) => {
    if (payload.personalityId !== coordinatorPersonality) return null;
    return { prependSystem: coordinatorSystem };
  });

  return { loop, toolRegistry, coordinatorPersonality, meshName, setOnSkillProposed };
}

function buildCoordinatorTeamPrompt(manifest: TeamManifest): string {
  const members = manifest.members.map((m) => m.personality);
  const teamName = manifest.name;
  const memberText = members.length > 0 ? members.join(', ') : 'none';
  return [
    `## Team Identity`,
    `You are the coordinator of team "${teamName}".`,
    `Your name is "${teamName}".`,
    `If asked your name, answer with "${teamName}".`,
    `If asked who you are, say you are the coordinator of this team and list your member personalities: ${memberText}.`,
    `For simple conversational questions (greetings, identity, coordination metadata), reply directly without any tool call.`,
    `Delegate only when specialist execution is required.`,
  ].join('\n');
}

/**
 * Resolve the active chat target from config and return a ready AgentLoop.
 * Dispatches to team or personality mode based on config.activeContext.
 */
export interface ActiveLoop {
  loop: AgentLoop;
  /** Personality ID to pass per-turn (the coordinator for teams). */
  personalityId: string;
  /** Human-readable label for the banner: "researcher" or "team:myteam". */
  displayName: string;
}

export async function resolveActiveLoop(
  config: EthosConfig,
  opts: { profile?: WiringProfile } = {},
): Promise<ActiveLoop> {
  if (config.activeContext?.type === 'team') {
    const teamName = config.activeContext.name;
    const { loop, coordinatorPersonality } = await createTeamAgentLoop(config, teamName, opts);
    applyCliOverrideHooks(loop, config);
    return { loop, personalityId: coordinatorPersonality, displayName: `team:${teamName}` };
  }
  const personalityId = config.activeContext?.name ?? config.personality;
  const { loop } = await createAgentLoop({ ...config, personality: personalityId }, opts);
  applyCliOverrideHooks(loop, config);
  return { loop, personalityId, displayName: personalityId };
}

// ---------------------------------------------------------------------------
// FW-8 — apply CLI override hooks after the AgentLoop is constructed
// ---------------------------------------------------------------------------

/**
 * Register hooks that enforce the CLI override flags (`--toolsets`, `-s`).
 * Called after every loop construction path in resolveActiveLoop so team
 * and solo modes both get the overrides.
 */
function applyCliOverrideHooks(loop: AgentLoop, config: EthosConfig): void {
  // --toolsets: reject before_tool_call for tools not in the allowed set
  if (config.cliToolsets && config.cliToolsets.length > 0) {
    const allowed = new Set(config.cliToolsets);
    loop.hooks.registerModifying('before_tool_call', async (payload) => {
      const tool = loop.getAvailableTools().find((t) => t.name === payload.toolName);
      if (tool?.toolset && !allowed.has(tool.toolset)) {
        return {
          error: `Tool '${payload.toolName}' (toolset: ${tool.toolset}) is disabled by --toolsets CLI override`,
        };
      }
      return null;
    });
  }

  // -s: prepend skill content to every turn's system prompt (content pre-loaded by applyCliOverrides)
  if (config.cliSkillContents && config.cliSkillContents.length > 0) {
    const skillContent = config.cliSkillContents.filter(Boolean).join('\n\n---\n\n');
    if (skillContent) {
      loop.hooks.registerModifying('before_prompt_build', async () => {
        return { prependSystem: skillContent };
      });
    }
  }
}
