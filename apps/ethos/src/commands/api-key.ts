import { hostname } from 'node:os';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import {
  AmbiguousPrefixError,
  type ApiKeyRecord,
  SqliteApiKeyStore,
} from '@ethosagent/session-sqlite';
import {
  type ApiKeyScope,
  ApiKeyScopeSchema,
  type ApiKeyStaticScope,
  ApiKeyStaticScopeSchema,
  PHONE_PRESET_SCOPES,
} from '@ethosagent/web-contracts';
import { resolveWebHost, resolveWebPort } from './serve-helpers';

// `ethos api-key` — manage bearer-token credentials for the OpenAI-compat
// `/v1/*` surface. Keys live alongside session state in `sessions.db` so
// `ethos serve` and this command share the same row set.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

// `chat` is the `/v1/*` scope, and the default because that surface is the
// only reason this command exists. Typed against `ApiKeyStaticScope` so the CLI
// and `ApiKeyStaticScopeSchema` cannot drift: keys minted here and keys minted
// through the web UI's `apiKeys.create` RPC must draw from one vocabulary.
const DEFAULT_SCOPES: ApiKeyStaticScope[] = ['chat'];
const USAGE =
  'Usage: ethos api-key [create --name <label> [--scopes <a,b>] [--preset phone] [--qr] [--json] | list [--json] | revoke <prefix>]';

const TRUST_SENTENCE =
  'This key lets the phone read, approve and talk. It cannot change agents or settings.';

export async function runApiKey(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const jsonMode = args.includes('--json');
  const store = openStore();
  try {
    switch (sub) {
      case 'create':
        await create(store, args.slice(1), jsonMode);
        break;
      case 'list':
        await list(store, jsonMode);
        break;
      case 'revoke':
        await revoke(store, args.slice(1));
        break;
      default:
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

function openStore(): SqliteApiKeyStore {
  return new SqliteApiKeyStore(join(ethosDir(), 'sessions.db'));
}

async function create(store: SqliteApiKeyStore, args: string[], jsonMode: boolean): Promise<void> {
  const preset = parseFlagValue(args, '--preset');
  if (preset !== undefined && preset !== 'phone') {
    console.log(`${c.red}Unknown preset "${preset}". The only preset is "phone".${c.reset}`);
    process.exit(1);
  }
  const isPhonePreset = preset === 'phone';

  // `--preset phone` needs no `--name` (mobile-app plan S1, S13(a)) — a
  // hostname-derived label stands in, since the phone key is minted from
  // wherever `ethos` runs, not typed by a human at the prompt.
  const name =
    parseFlagValue(args, '--name') ?? (isPhonePreset ? `phone-${hostname()}` : undefined);
  if (!name) {
    console.log('Missing --name. Usage: ethos api-key create --name <label> [--scopes <a,b>]');
    process.exit(1);
  }

  // `PHONE_PRESET_SCOPES` (mobile-app plan S13(a)) is the ONE source for this
  // list — the CLI, the web's Generate QR code, and the app's
  // `REQUIRED_SCOPES` all read it rather than restating it. The preset wins
  // over `--scopes` when both are given.
  const scopesArg = parseFlagValue(args, '--scopes');
  const scopes: ApiKeyScope[] = isPhonePreset
    ? PHONE_PRESET_SCOPES
    : scopesArg === undefined
      ? DEFAULT_SCOPES
      : parseScopes(scopesArg);

  // `allowedOrigins: []` — React Native cannot send an `Origin` header at
  // all (mobile-app plan S1), and it is already the store's own default for
  // every CLI-minted key (`api-key-store.ts:89`).
  const { secret, record } = await store.create({ name, scopes, allowedOrigins: [] });

  if (jsonMode) {
    const payload = {
      name: record.name,
      key: secret,
      prefix: record.prefix,
      scopes: record.scopes,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (args.includes('--qr')) await printConnectQr(secret, args);
    return;
  }

  console.log();
  console.log(`${c.green}✓ API key created${c.reset}  ${c.dim}name: ${record.name}${c.reset}`);
  console.log();
  console.log(`  ${c.bold}${secret}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}prefix: ${record.prefix}${c.reset}`);
  console.log(`  ${c.dim}scopes: ${record.scopes.join(', ')}${c.reset}`);
  console.log();
  if (isPhonePreset) {
    console.log(`  ${c.dim}${TRUST_SENTENCE}${c.reset}`);
    console.log();
  }
  console.log(`  ${c.yellow}This is the only time the full key is shown. Save it now.${c.reset}`);
  console.log();
  if (args.includes('--qr')) await printConnectQr(secret, args);
}

/**
 * Prints `ethos://connect?url=<url>&key=<secret>` as a unicode/ANSI QR
 * (mobile-app plan S7) — scanned by the phone's camera, never a tap-to-open
 * link (D3's scan-only rule). The URL shares `resolveConnectInfo`
 * (`@ethosagent/web-api`) with `meta.connectInfo` so the terminal and the
 * web's Generate QR code never disagree about which address to encode.
 */
async function printConnectQr(secret: string, args: string[]): Promise<void> {
  // Dynamic imports: `@ethosagent/web-api` and `../wiring` are heavy (the
  // whole agent-loop/wiring graph) and otherwise unused by `ethos api-key` —
  // loading them only when `--qr` is actually passed keeps every other
  // invocation (and this module's own tests) off that cost.
  const [{ resolveConnectInfo }, { getSecretsResolver, getStorage }, { readConfig }] =
    await Promise.all([
      import('@ethosagent/web-api'),
      import('../wiring'),
      import('@ethosagent/config'),
    ]);
  const config = await readConfig(getStorage(), await getSecretsResolver());
  const { url } = resolveConnectInfo({
    env: process.env,
    configWebBaseUrl: config?.webBaseUrl ?? null,
    webHost: resolveWebHost(args, process.env, config),
    webPort: resolveWebPort(args, process.env, config),
  });
  const connectUrl = `ethos://connect?url=${encodeURIComponent(url)}&key=${encodeURIComponent(secret)}`;
  // `qrcode-terminal` is CJS: the ESM namespace carries only `default`, so
  // `ns.generate` is undefined (verified on 0.12.0 — `Object.keys` is
  // `['default', 'error', 'module.exports']`).
  const qrterm = (await import('qrcode-terminal')).default;
  console.log();
  qrterm.generate(connectUrl, { small: true });
  console.log();
}

async function list(store: SqliteApiKeyStore, jsonMode: boolean): Promise<void> {
  const all = await store.list();

  if (jsonMode) {
    const payload = all.map((k) => ({
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt.toISOString(),
    }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (all.length === 0) {
    console.log(`\n${c.dim}No API keys yet.${c.reset}`);
    console.log(`${c.dim}Create one with: ${c.reset}ethos api-key create --name <label>\n`);
    return;
  }
  console.log();
  console.log(`${c.bold}API keys${c.reset}  ${c.dim}(${all.length})${c.reset}`);
  for (const k of all) {
    console.log(`  ${c.cyan}${k.prefix}${c.reset}  ${k.name}  ${formatKey(k)}`);
  }
  console.log();
}

async function revoke(store: SqliteApiKeyStore, args: string[]): Promise<void> {
  const prefix = args[0];
  if (!prefix) {
    console.log('Usage: ethos api-key revoke <prefix>');
    process.exit(1);
  }
  try {
    const revoked = await store.revoke(prefix);
    if (!revoked) {
      console.log(`${c.red}No active API key matches prefix "${prefix}".${c.reset}`);
      process.exit(1);
    }
    console.log(
      `${c.green}✓ Revoked${c.reset}  ${revoked.prefix}  ${c.dim}${revoked.name}${c.reset}`,
    );
  } catch (err) {
    if (err instanceof AmbiguousPrefixError) {
      console.log(`${c.red}${err.message}${c.reset}`);
      process.exit(1);
    }
    throw err;
  }
}

function formatKey(k: ApiKeyRecord): string {
  const scopes = `${c.dim}scopes:${c.reset} ${k.scopes.join(',')}`;
  const lastUsed = k.lastUsed ? `last used ${k.lastUsed.toISOString()}` : 'never used';
  const status = k.revokedAt ? `${c.red}revoked${c.reset}` : `${c.dim}active${c.reset}`;
  return `${scopes}  ${c.dim}${lastUsed}${c.reset}  ${status}`;
}

// `mcp:<id>` is open-ended — one scope per exported personality — so it cannot
// be listed the way the fixed enum can. Name its SHAPE alongside the list, or
// the "valid scopes" line reads as exhaustive when it is not.
const MCP_SCOPE_HINT = 'mcp:<personality-id>  (one exported personality per key)';

function printValidScopes(): void {
  console.log(`${c.dim}Valid scopes: ${ApiKeyStaticScopeSchema.options.join(', ')}${c.reset}`);
  console.log(`${c.dim}           or ${MCP_SCOPE_HINT}${c.reset}`);
}

/**
 * Validate `--scopes a,b` against `ApiKeyScopeSchema`. Unknown scopes used to
 * be accepted verbatim — `SqliteApiKeyStore.create` stores whatever it is
 * handed — which minted a key that authenticated everywhere and authorized
 * nothing. Fail loudly instead, and name the valid set.
 */
function parseScopes(raw: string): ApiKeyScope[] {
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    console.log(`${c.red}--scopes was empty. Pass at least one scope.${c.reset}`);
    printValidScopes();
    process.exit(1);
  }
  const scopes: ApiKeyScope[] = [];
  const unknown: string[] = [];
  for (const candidate of requested) {
    const parsed = ApiKeyScopeSchema.safeParse(candidate);
    if (parsed.success) scopes.push(parsed.data);
    else unknown.push(candidate);
  }
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'scope' : 'scopes';
    console.log(`${c.red}Unknown ${label}: ${unknown.join(', ')}${c.reset}`);
    printValidScopes();
    process.exit(1);
  }
  return scopes;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
