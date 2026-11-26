import { ethosDir, readConfig, resolveShareLinks } from '@ethosagent/config';
import { EthosError, TOOL_PROCESS_ENV_VAR } from '@ethosagent/types';
import {
  AmbiguousSharePrefixError,
  createSessionStore,
  publishShare,
  resolveShareBaseUrl,
  type ShareExpiry,
  type ShareLinkSummary,
  SharePrefixTooShortError,
  type ShareRefusal,
  SqliteShareLinkStore,
  shareLinksDbPath,
} from '@ethosagent/wiring';
import { sayFor, splitJson, writeJson } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';
import { cleanLine } from './personality-amendments';
import { resolveWebHost, resolveWebPort } from './serve-helpers';

// `ethos sessions share <id> | share list | share revoke <prefix>` (plan share-links §3, D4, D7,
// D13). Refusals come from wiring's `publishShare` (packages/wiring/src/share-publish.ts); this
// file only maps them to EthosError. Failures throw EthosError and exit 1 through index.ts's
// top-level handler, which also emits the one --json error document
// (apps/ethos/src/__tests__/cli-json-throw.test.ts). Pinned by
// commands/__tests__/sessions-share.test.ts. D12: `create` refuses under ETHOS_TOOL_PROCESS=1
// ('D12: create refuses inside a tool process'); list and revoke do not. A TRIPWIRE, not a
// boundary: `env -u` defeats it, and a shell can write share-links.db directly.

const EXPIRIES: readonly ShareExpiry[] = ['1h', '1d', '7d', '30d'];
const DEFAULT_EXPIRY: ShareExpiry = '7d';

export const LOOPBACK_WARNING =
  'Opens only on this machine — set webBaseUrl and expose the port to share';

const USAGE =
  'Usage: ethos sessions share <session_id> [--expires 1h|1d|7d|30d] [--tools] [--no-pii] [--json]\n' +
  '       ethos sessions share list [--json]\n' +
  '       ethos sessions share revoke <prefix> [--json]';

function openShareStore(): SqliteShareLinkStore {
  return new SqliteShareLinkStore(shareLinksDbPath(ethosDir()));
}

function invalid(cause: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action: USAGE });
}

function refusalError(r: ShareRefusal): EthosError {
  switch (r.reason) {
    case 'disabled':
      return new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'Share links are turned off.',
        action: 'Set `shareLinks.enabled: true` in ~/.ethos/config.yaml.',
      });
    case 'not_found':
      return new EthosError({
        code: 'SESSION_NOT_FOUND',
        cause: 'Session not found.',
        action: 'Check the session ID with `ethos sessions list`.',
      });
    case 'shared_session':
      return new EthosError({
        code: 'FORBIDDEN',
        cause: 'This is a shared-room or incognito session; it cannot be shared.',
        action: 'Only private sessions can be published as a link.',
      });
    case 'excluded_personality':
      return new EthosError({
        code: 'FORBIDDEN',
        cause: `Personality "${r.personalityId}" is excluded from share links.`,
        action: 'Remove it from `shareLinks.excludePersonalities` in ~/.ethos/config.yaml.',
      });
    case 'too_large':
      return new EthosError({
        code: 'INVALID_INPUT',
        cause: `The redacted conversation is larger than the ${r.limitBytes}-byte share limit.`,
        action: 'Share a shorter session.',
      });
    case 'empty':
      return new EthosError({
        code: 'INVALID_INPUT',
        cause: 'The session has no user or assistant text to share.',
        action: 'Check the session ID with `ethos sessions list`.',
      });
  }
}

/** Value of `--flag <value>`, or undefined. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function parseExpiry(args: readonly string[]): ShareExpiry {
  const raw = flagValue(args, '--expires');
  if (raw === undefined) {
    if (args.includes('--expires')) throw invalid('--expires needs a value: 1h, 1d, 7d or 30d.');
    return DEFAULT_EXPIRY;
  }
  const match = EXPIRIES.find((e) => e === raw);
  if (!match) throw invalid(`Unknown --expires "${raw}". Use one of: ${EXPIRIES.join(', ')}.`);
  return match;
}

/** Positional args: everything that is neither a flag nor the value of `--expires`. */
function positionals(args: readonly string[]): string[] {
  return args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--expires');
}

export async function runSessionsShare(argv: string[]): Promise<void> {
  const { json, args } = splitJson(argv);
  const first = positionals(args)[0];
  if (first === 'list') return shareList(json);
  if (first === 'revoke') return shareRevoke(positionals(args)[1], json);
  if (!first) throw invalid('Missing session id.');
  return shareCreate(first, args, json);
}

/** Same tripwire as `personality amendments apply` (personality-amendments.ts assertNotToolProcess). */
function assertNotToolProcess(env: Readonly<Record<string, string | undefined>>): void {
  if (env[TOOL_PROCESS_ENV_VAR] !== '1') return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: `${TOOL_PROCESS_ENV_VAR}=1: this looks like a process an agent's tool started, and an agent does not publish its own conversations`,
    action:
      'Run this from your own terminal. (This check is a tripwire, not a boundary: it catches the plain case only.)',
  });
}

async function shareCreate(sessionId: string, args: string[], json: boolean): Promise<void> {
  assertNotToolProcess(process.env);
  const expiresIn = parseExpiry(args);
  const config = await readConfig(getStorage(), await getSecretsResolver());
  const baseUrl = resolveShareBaseUrl({
    webBaseUrl: config?.webBaseUrl,
    bindHost: resolveWebHost(args, process.env, config),
    port: resolveWebPort(args, process.env, config),
  });
  const sessions = createSessionStore({ dataDir: ethosDir() });
  const store = openShareStore();
  try {
    const result = await publishShare(
      {
        store,
        shareLinks: resolveShareLinks(config ?? {}),
        sessions,
        now: () => new Date(),
      },
      {
        sessionId,
        expiresIn,
        includeToolNames: args.includes('--tools'),
        pii: !args.includes('--no-pii'),
        actor: 'cli',
        baseUrl,
      },
    );
    if (!result.ok) throw refusalError(result);

    const say = sayFor(json);
    if (json) {
      writeJson({
        url: result.url,
        prefix: result.prefix,
        expiresAt: result.expiresAt,
        loopback: result.loopback,
      });
    } else {
      say('');
      say(`Share link created  (prefix ${result.prefix}, expires ${result.expiresAt})`);
      say('');
      say(`  ${result.url}`);
      say('');
      say("You won't see this link again. Revoke it with `ethos sessions share revoke <prefix>`.");
    }
    // D4 / §10: a loopback link must say so; stderr under --json keeps stdout one document.
    if (result.loopback) say(`Warning: ${LOOPBACK_WARNING}`);
    if (!json) say('');
  } finally {
    store.close();
    sessions.close();
  }
}

function describeLink(l: ShareLinkSummary): string {
  return (
    `  ${l.prefix}  ${cleanLine(l.title) || '(untitled)'}\n` +
    `    created ${l.createdAt}  expires ${l.expiresAt}  views ${l.viewCount}` +
    `  last viewed ${l.lastViewedAt ?? 'never'}`
  );
}

function shareList(json: boolean): void {
  const store = openShareStore();
  try {
    const links = store.list({ activeOnly: true });
    if (json) {
      writeJson(
        links.map((l) => ({
          id: l.id,
          prefix: l.prefix,
          sessionId: l.sessionId,
          title: l.title,
          createdAt: l.createdAt,
          expiresAt: l.expiresAt,
          viewCount: l.viewCount,
          lastViewedAt: l.lastViewedAt,
        })),
      );
      return;
    }
    if (links.length === 0) {
      console.log('\nNo active share links.\n');
      return;
    }
    console.log(`\nShare links (${links.length})`);
    for (const l of links) console.log(describeLink(l));
    console.log();
  } finally {
    store.close();
  }
}

function shareRevoke(prefix: string | undefined, json: boolean): void {
  if (!prefix) throw invalid('Missing link prefix.');
  const store = openShareStore();
  try {
    let revoked: ReturnType<SqliteShareLinkStore['revoke']>;
    try {
      revoked = store.revoke(prefix, 'cli');
    } catch (err) {
      if (err instanceof AmbiguousSharePrefixError || err instanceof SharePrefixTooShortError) {
        throw invalid(err.message);
      }
      throw err;
    }
    if (!revoked) {
      throw new EthosError({
        code: 'NOT_FOUND',
        cause: `No share link matches "${prefix}".`,
        action: 'List active links with `ethos sessions share list`.',
      });
    }
    if (json) writeJson({ revoked: true, id: revoked.id, prefix: revoked.prefix });
    else console.log(`Revoked  ${revoked.prefix}  ${cleanLine(revoked.title) || '(untitled)'}`);
  } finally {
    store.close();
  }
}

/**
 * `sessions delete` hook: revoke every live link of a session about to be deleted (plan §3).
 * Returns how many were revoked. Opens no store when share-links.db does not exist, so a
 * deployment that never shared anything gains no file.
 */
export async function revokeSharesForSession(sessionId: string): Promise<number> {
  const path = shareLinksDbPath(ethosDir());
  try {
    if (!(await getStorage().exists(path))) return 0;
    const store = new SqliteShareLinkStore(path);
    try {
      return store.revokeForSession(sessionId, 'cli');
    } finally {
      store.close();
    }
  } catch (err) {
    if (err instanceof EthosError) throw err;
    throw new EthosError({
      code: 'INTERNAL',
      cause: `Could not revoke share links, so the session was not deleted: ${err instanceof Error ? err.message : String(err)}`,
      action: 'Fix or move ~/.ethos/share-links.db, then run `ethos sessions delete` again.',
    });
  }
}
