import type { Logger, Storage } from '@ethosagent/types';

/**
 * Shared context passed to extension `compose()` functions. Contains
 * everything an extension needs to construct its components without
 * importing wiring internals.
 *
 * Deliberately avoids referencing WiringConfig so extensions don't
 * take a reverse dependency on the wiring package.
 */
export interface WiringContext {
  storage: Storage;
  dataDir: string;
  workingDir: string;
  log: Logger;
}
