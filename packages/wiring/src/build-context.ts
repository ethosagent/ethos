import { noopLogger } from '@ethosagent/logger';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import type { CreateAgentLoopOptions, WiringProfile } from './index';
import type { WiringContext } from './types';

export interface BuildContextResult {
  wiringCtx: WiringContext;
  dataDir: string;
  workingDir: string;
  profile: WiringProfile;
  log: Logger;
  NOOP_SECRETS: SecretsResolver;
}

/**
 * Build the WiringContext and resolve top-level options (dataDir, workingDir,
 * profile, logger) from CreateAgentLoopOptions. Also constructs the
 * NOOP_SECRETS fallback.
 */
export function buildWiringContext(opts: CreateAgentLoopOptions): BuildContextResult {
  const { dataDir } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const profile: WiringProfile = opts.profile ?? 'cli';
  const log: Logger = opts.logger ?? noopLogger;

  const NOOP_SECRETS: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  const wiringCtx: WiringContext = {
    // L-T3 — a replay arm reads the whole tree through its `OverlayStorage`:
    // one shadowed path, every write refused (`CreateAgentLoopOptions.replay`).
    // Every other caller gets the plain filesystem, exactly as before.
    storage: opts.replay ? opts.replay.storage : new FsStorage(),
    dataDir,
    workingDir,
    log,
    ...(opts.builtinPersonalitiesDir
      ? { builtinPersonalitiesDir: opts.builtinPersonalitiesDir }
      : {}),
    ...(opts.callCaptureNativeDir ? { callCaptureNativeDir: opts.callCaptureNativeDir } : {}),
  };

  return { wiringCtx, dataDir, workingDir, profile, log, NOOP_SECRETS };
}
