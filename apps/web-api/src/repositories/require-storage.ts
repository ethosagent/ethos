import { EthosError, type Storage } from '@ethosagent/types';

/**
 * Assert an injected `Storage` is present. The web-api data layer never
 * constructs its own FsStorage — the composition root (`src/index.ts`) owns
 * that and threads a single instance down. A missing backend is a wiring bug,
 * surfaced as a typed `NOT_CONFIGURED` error rather than a silent fallback to
 * raw disk (which would defeat the storage isolation boundary).
 */
export function requireStorage(storage: Storage | undefined, who: string): Storage {
  if (!storage) {
    throw new EthosError({
      code: 'NOT_CONFIGURED',
      cause: `${who} was constructed without a Storage backend`,
      action: 'Construct it from the web-api composition root with an injected Storage.',
    });
  }
  return storage;
}
