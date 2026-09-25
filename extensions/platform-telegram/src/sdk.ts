// The Telegram adapter's ONLY runtime import of `grammy`.
//
// `grammy` is an optionalDependency of @ethosagent/cli: `npm install
// --omit=optional` (the lean install apps/ethos/README.md recommends) leaves it
// out. The CLI bundle inlines this package, so a top-level `import … from
// 'grammy'` anywhere in it became a top-level import of the whole CLI and every
// command crashed with ERR_MODULE_NOT_FOUND. Loading it here, when the gateway
// builds the adapter (`loadAdapterModule` in apps/ethos/src/commands/gateway.ts),
// turns a missing SDK into "Telegram adapter unavailable" for that adapter only.
// Every other file takes grammy's types with `import type`. Enforced by
// scripts/check-bundle-deps.sh (no static import of an optionalDependency).

import type * as GrammyModule from 'grammy';

export type Grammy = typeof GrammyModule;

let loaded: Grammy | undefined;

/**
 * Load grammy once; throws a clear, actionable error when it is not installed.
 * `importSdk` exists for tests (a module that is not installed cannot be mocked
 * as missing); production always takes the default.
 */
export async function loadTelegramSdk(
  importSdk: () => Promise<Grammy> = () => import('grammy'),
): Promise<Grammy> {
  if (!loaded) {
    try {
      loaded = await importSdk();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('Telegram adapter needs grammy; install it with npm install -g grammy');
      }
      throw err;
    }
  }
  return loaded;
}

/** The loaded SDK. `loadTelegramSdk()` must have resolved first. */
export function grammy(): Grammy {
  if (!loaded) {
    throw new Error(
      'Telegram adapter: grammy is not loaded — await loadTelegramSdk() before constructing TelegramAdapter.',
    );
  }
  return loaded;
}
