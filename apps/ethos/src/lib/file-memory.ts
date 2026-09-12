// The CLI's handle on file-style memory (MEMORY.md / USER.md, the archive, the
// lifecycle sidecar, provenance history) for the CONFIGURED backend — markdown
// at ~/.ethos, or the vault under `memory: vault` (F04 follow-up, plan
// architecture-suggestions-2026-09-10). Every CLI and Slack memory surface opens
// memory through here so it acts on what the agent reads, never on an assumed
// markdown root.
import { ethosDir } from '@ethosagent/config';
import { EthosError } from '@ethosagent/types';
import {
  type ConfiguredMemoryBackend,
  createMemoryProviderFromConfig,
  fileMemoryUnsupportedReason,
  type HistorySource,
  type MemoryBackendSelection,
} from '@ethosagent/wiring';
import { getStorage } from '../wiring';

/**
 * Open the configured backend's file memory, history-labelled with `source`.
 *
 * Throws NOT_CONFIGURED for a backend with no file memory (`vector`) — the same
 * predicate and reason the web editor refuses with
 * (`fileMemoryUnsupportedReason`, shared with `createMemoryBundle`).
 */
export function openFileMemory(
  config: MemoryBackendSelection | null,
  source: HistorySource,
): ConfiguredMemoryBackend {
  const selection = config ?? {};
  const reason = fileMemoryUnsupportedReason(selection);
  if (reason) {
    throw new EthosError({
      code: 'NOT_CONFIGURED',
      cause: reason,
      action:
        'Use `ethos memory show` to list vector memory, or switch `memory:` to markdown or vault in config.yaml.',
    });
  }
  return createMemoryProviderFromConfig({
    config: selection,
    dataDir: ethosDir(),
    storage: getStorage(),
    source,
  });
}

/**
 * The prefetched file memory for one personality, joined for display, or null
 * when empty — what chat's `/memory` and the TUI's `/memory` print. Throws the
 * `openFileMemory` refusal for a backend with no file memory.
 */
export async function readFileMemorySnapshot(
  config: MemoryBackendSelection | null,
  scope: { personalityId: string; sessionKey: string },
): Promise<string | null> {
  const result = await openFileMemory(config, 'tool').provider.prefetch({
    scopeId: `personality:${scope.personalityId}`,
    sessionId: '',
    sessionKey: scope.sessionKey,
    platform: 'cli',
    workingDir: process.cwd(),
  });
  if (!result || result.entries.length === 0) return null;
  return result.entries.map((e) => e.content.trim()).join('\n\n');
}
