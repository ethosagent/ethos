// The Slack adapter's ONLY runtime import of `@slack/bolt`.
//
// `@slack/bolt` is an optionalDependency of @ethosagent/cli: `npm install
// --omit=optional` (the lean install apps/ethos/README.md recommends) leaves it
// out. The CLI bundle inlines this package, so a top-level import of Bolt
// anywhere in it became a top-level import of the whole CLI and every command
// crashed with ERR_MODULE_NOT_FOUND. Loading it here, when the gateway builds
// the adapter (`loadAdapterModule` in apps/ethos/src/commands/gateway.ts), turns
// a missing SDK into "Slack adapter unavailable" for that adapter only. Every
// other file takes Bolt's types with `import type`. Enforced by
// scripts/check-bundle-deps.sh (no static import of an optionalDependency).

import type * as BoltModule from '@slack/bolt';

export type Bolt = typeof BoltModule;

let loaded: Bolt | undefined;

/**
 * Load Bolt once; throws a clear, actionable error when it is not installed.
 * `importSdk` exists for tests (a module that is not installed cannot be mocked
 * as missing); production always takes the default.
 */
export async function loadSlackSdk(
  importSdk: () => Promise<Bolt> = () => import('@slack/bolt'),
): Promise<Bolt> {
  if (!loaded) {
    try {
      const ns = await importSdk();
      // Bolt is CommonJS: under Node's ESM loader its API is the default export.
      loaded = (ns as { default?: Bolt }).default ?? ns;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error(
          'Slack adapter needs @slack/bolt; install it with npm install -g @slack/bolt',
        );
      }
      throw err;
    }
  }
  return loaded;
}

/** The loaded SDK. `loadSlackSdk()` must have resolved first. */
export function bolt(): Bolt {
  if (!loaded) {
    throw new Error(
      'Slack adapter: @slack/bolt is not loaded — await loadSlackSdk() before constructing SlackAdapter.',
    );
  }
  return loaded;
}
