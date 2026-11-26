import type { SessionStore } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShareFeature } from '../wire';

// plan share-links D2: purge failures are not silent. buildShareFeature hands startSharePurge an
// onError that writes to the web-api's Logger (the injected one, else a ConsoleLogger).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('buildShareFeature purge failures', () => {
  it('logs a failing purge through the logger instead of swallowing it', () => {
    const error = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error, child: () => logger };
    const store = {
      purgeExpired: () => {
        throw new Error('database is locked');
      },
      revokeOrphans: async () => 0,
      close: () => {},
    };
    const feature = buildShareFeature({
      host: { store: store as never, bind: { host: '127.0.0.1', port: 3000 } },
      configSource: { readSource: async () => null },
      admin: { username: async () => null },
      sessions: { getSession: async () => null } as unknown as SessionStore,
      webBaseUrl: undefined,
      trustProxy: undefined,
      logger,
    });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain('database is locked');
    feature.stop();
  });
});
