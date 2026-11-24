import type { Storage } from '@ethosagent/types';
import { resolveWebTokenEnv, WebTokenRepository } from '@ethosagent/web-api';

/**
 * The web token this process's embedded web-api authenticates against. The
 * server runs in-process (serve.ts) and, when `ETHOS_WEB_TOKEN` is set, never
 * reads the token file (web-token.repository.ts), so the desktop's own cookie
 * must resolve the same env token. `resolveEnv` is a test seam.
 */
export function createDesktopWebTokenRepository(
  dataDir: string,
  storage: Storage,
  resolveEnv: () => string | undefined = resolveWebTokenEnv,
): WebTokenRepository {
  const envToken = resolveEnv();
  return new WebTokenRepository({
    dataDir,
    storage,
    ...(envToken !== undefined ? { envToken } : {}),
  });
}
