import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { meshRegistryPath, setMeshObservabilityService } from '@ethosagent/agent-mesh';
import type { AgentLoop } from '@ethosagent/core';
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
  startPruneCron,
} from '@ethosagent/observability-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import { parseTeamManifest, teamsDir } from '@ethosagent/team-supervisor';
import type { LLMProvider, RetentionConfig, Storage, TeamManifest } from '@ethosagent/types';
import {
  createAgentLoop as packageCreateAgentLoop,
  createLLM as packageCreateLLM,
  type WiringProfile,
} from '@ethosagent/wiring';
import { type EthosConfig, ethosDir, readKeys } from './config';
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

let obsSingleton: ObservabilityService | undefined;
let pruneStop: (() => void) | undefined;

/**
 * The CLI's process-wide ObservabilityService. Creates the SQLite store and
 * blob store on first access, then returns the same instance thereafter.
 */
export function getObservabilityService(): ObservabilityService {
  if (!obsSingleton) {
    const dir = ethosDir();
    const storage = getStorage();
    const store = new SQLiteObservabilityStore(join(dir, 'observability.db'));
    const blobStore = new BlobStore(join(dir, 'blobs'), storage);
    obsSingleton = new ObservabilityService(store, blobStore);
    setObservabilityService(obsSingleton);
    setMeshObservabilityService(obsSingleton);
  }
  return obsSingleton;
}

/**
 * Start the nightly observability prune cron job (03:00 local time).
 * Idempotent — calling it more than once is safe; the second call is a no-op.
 * Returns a stop function for clean shutdown.
 */
export function startNightlyPrune(config?: RetentionConfig): () => void {
  if (!pruneStop) {
    const handle = startPruneCron({
      obsDbPath: join(ethosDir(), 'observability.db'),
      config,
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

async function withRotation(config: EthosConfig) {
  const rotationKeys = config.provider === 'anthropic' ? await readKeys(getStorage()) : [];
  return { ...config, rotationKeys };
}

export async function createLLM(config: EthosConfig): Promise<LLMProvider> {
  return packageCreateLLM(await withRotation(config));
}

export async function createAgentLoop(
  config: EthosConfig,
  opts: { profile?: WiringProfile; meshRegistryPath?: string } = {},
): Promise<AgentLoop> {
  return packageCreateAgentLoop(await withRotation(config), {
    dataDir: ethosDir(),
    workingDir: process.cwd(),
    profile: opts.profile ?? 'cli',
    logger,
    meshRegistryPath: opts.meshRegistryPath,
    observability: getObservabilityService(),
  });
}

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

export interface TeamLoopInfo {
  loop: AgentLoop;
  /** Personality the coordinator runs as. */
  coordinatorPersonality: string;
  /** Mesh name (team name unless manifest.mesh overrides it). */
  meshName: string;
}

/** Resolve a team manifest by name (local ./team.yaml or ~/.ethos/teams/<n>.yaml). */
export function loadTeamManifest(teamName: string): TeamManifest {
  const local = resolvePath('./team.yaml');
  try {
    const src = readFileSync(local, 'utf-8');
    const m = parseTeamManifest(src);
    if (m.name === teamName) return m;
  } catch {
    // not present or name mismatch
  }
  return parseTeamManifest(readFileSync(join(teamsDir(), `${teamName}.yaml`), 'utf-8'));
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
  opts: { profile?: WiringProfile } = {},
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

  const loop = await createAgentLoop(
    { ...coordinatorConfig, personality: coordinatorPersonality },
    { profile: opts.profile ?? 'cli', meshRegistryPath: meshRegistryPath(meshName) },
  );

  const coordinatorSystem = buildCoordinatorTeamPrompt(manifest);
  loop.hooks.registerModifying('before_prompt_build', async (payload) => {
    if (payload.personalityId !== coordinatorPersonality) return null;
    return { prependSystem: coordinatorSystem };
  });

  return { loop, coordinatorPersonality, meshName };
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
    return { loop, personalityId: coordinatorPersonality, displayName: `team:${teamName}` };
  }
  const personalityId = config.activeContext?.name ?? config.personality;
  const loop = await createAgentLoop({ ...config, personality: personalityId }, opts);
  return { loop, personalityId, displayName: personalityId };
}
