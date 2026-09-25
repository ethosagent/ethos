// The Discord adapter's ONLY runtime import of `discord.js`.
//
// `discord.js` is an optionalDependency of @ethosagent/cli: `npm install
// --omit=optional` (the lean install apps/ethos/README.md recommends) leaves it
// out. The CLI bundle inlines this package, so a top-level import of
// discord.js anywhere in it became a top-level import of the whole CLI and
// every command crashed with ERR_MODULE_NOT_FOUND. Loading it here, when the
// gateway builds the adapter (`loadAdapterModule` in
// apps/ethos/src/commands/gateway.ts), turns a missing SDK into "Discord adapter
// unavailable" for that adapter only. Every other file takes discord.js types
// with `import type`. Enforced by scripts/check-bundle-deps.sh (no static
// import of an optionalDependency).

import type * as DiscordModule from 'discord.js';

export type DiscordJs = typeof DiscordModule;

let loaded: DiscordJs | undefined;

/**
 * Load discord.js once; throws a clear, actionable error when it is not
 * installed. `importSdk` exists for tests (a module that is not installed cannot
 * be mocked as missing); production always takes the default.
 */
export async function loadDiscordSdk(
  importSdk: () => Promise<DiscordJs> = () => import('discord.js'),
): Promise<DiscordJs> {
  if (!loaded) {
    try {
      loaded = await importSdk();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'Discord adapter needs discord.js; install it with npm install -g discord.js',
        );
      }
      throw err;
    }
  }
  return loaded;
}

/** The loaded SDK. `loadDiscordSdk()` must have resolved first. */
export function discord(): DiscordJs {
  if (!loaded) {
    throw new Error(
      'Discord adapter: discord.js is not loaded — await loadDiscordSdk() before constructing DiscordAdapter.',
    );
  }
  return loaded;
}
