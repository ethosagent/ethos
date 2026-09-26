// The email adapter's ONLY runtime imports of `imapflow`, `mailparser` and
// `nodemailer`.
//
// All three are optionalDependencies of @ethosagent/cli: `npm install
// --omit=optional` (the lean install apps/ethos/README.md recommends) leaves
// them out. The CLI bundle inlines this package, so a top-level import of any of
// them became a top-level import of the whole CLI and every command crashed with
// ERR_MODULE_NOT_FOUND. Loading them here, when the gateway builds the adapter
// (`loadAdapterModule` in apps/ethos/src/commands/gateway.ts), turns a missing
// SDK into "Email adapter unavailable" for that adapter only. Every other file
// takes their types with `import type`. Enforced by scripts/check-bundle-deps.sh
// (no static import of an optionalDependency).

import type * as ImapflowModule from 'imapflow';
import type * as MailparserModule from 'mailparser';
import type * as NodemailerModule from 'nodemailer';

export interface EmailSdk {
  imapflow: typeof ImapflowModule;
  mailparser: typeof MailparserModule;
  nodemailer: typeof NodemailerModule;
}

let loaded: EmailSdk | undefined;

/** `load()`, or `undefined` with `name` recorded when the package is not installed. */
async function tryImport<T>(
  load: () => Promise<T>,
  name: string,
  missing: string[],
): Promise<T | undefined> {
  try {
    return await load();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    missing.push(name);
    return undefined;
  }
}

const DEFAULT_IMPORTS: { [K in keyof EmailSdk]: () => Promise<EmailSdk[K]> } = {
  imapflow: () => import('imapflow'),
  mailparser: () => import('mailparser'),
  nodemailer: () => import('nodemailer'),
};

/**
 * Load the three SDKs once; throws a clear, actionable error naming every
 * missing one. `imports` exists for tests (a module that is not installed
 * cannot be mocked as missing); production always takes the default.
 */
export async function loadEmailSdk(imports = DEFAULT_IMPORTS): Promise<EmailSdk> {
  if (!loaded) {
    const missing: string[] = [];
    const imapflow = await tryImport(imports.imapflow, 'imapflow', missing);
    const mailparser = await tryImport(imports.mailparser, 'mailparser', missing);
    const nodemailer = await tryImport(imports.nodemailer, 'nodemailer', missing);
    if (!imapflow || !mailparser || !nodemailer) {
      throw new Error(
        `Email adapter needs ${missing.join(', ')}; install it with npm install -g ${missing.join(' ')}`,
      );
    }
    loaded = { imapflow, mailparser, nodemailer };
  }
  return loaded;
}

/** The loaded SDKs. `loadEmailSdk()` must have resolved first. */
export function emailSdk(): EmailSdk {
  if (!loaded) {
    throw new Error(
      'Email adapter: imapflow/mailparser/nodemailer are not loaded — await loadEmailSdk() before using EmailAdapter.',
    );
  }
  return loaded;
}
