import { join } from 'node:path';
import { minimalHostEnv } from '@ethosagent/core';
import type { HostEnvContext } from './pool';

/**
 * The host's environment (plan §5.7, D12): `minimalHostEnv()` (credential-shaped
 * names and values and every `ETHOS_DOTENV_KEYS` name are already dropped) minus
 * `SSH_AUTH_SOCK` and `NODE_OPTIONS`, with `HOME`, `TMPDIR` and `XDG_*` moved
 * to the host's private dirs and `ETHOS_PLUGIN_HOST=1` added. Pinned by the
 * "process.env has none of ..." case in `__tests__/isolation-boundary.test.ts`.
 *
 * This is env scrubbing only. Without `plugins.host.sandbox: auto` it does
 * nothing about files (D6).
 */
export function buildHostEnv(ctx: HostEnvContext): Record<string, string> {
  const env = minimalHostEnv(undefined);
  delete env.SSH_AUTH_SOCK;
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (key.startsWith('XDG_')) delete env[key];
  env.HOME = ctx.hostHome;
  env.TMPDIR = ctx.tmpDir;
  env.XDG_CONFIG_HOME = join(ctx.hostHome, '.config');
  env.XDG_DATA_HOME = join(ctx.hostHome, '.local', 'share');
  env.XDG_CACHE_HOME = join(ctx.hostHome, '.cache');
  env.XDG_STATE_HOME = join(ctx.hostHome, '.local', 'state');
  env.ETHOS_PLUGIN_HOST = '1';
  return env;
}
