// `ethos catalog list|search|show|install|grant` (plan/phases/unified-catalog.md
// §5.4, §6.3, D13).
//
// `list`, `search` and `show` are read-only: they print the in-repo index, the
// `ethos catalog install` command for an entry, the by-hand commands it
// dispatches to, and the grant command. `install` and `grant` live in
// ./catalog-install.ts and are loaded on demand. This file imports
// `@ethosagent/catalog` only. Output shapes pinned by
// apps/ethos/src/__tests__/catalog-command.test.ts and
// catalog-install-command.test.ts.

import { CATALOG_ENTRIES } from '@ethosagent/catalog';
import { filterCatalog, installFlags } from '@ethosagent/catalog/filter';
import { CATALOG_KINDS, type CatalogEntry, type CatalogKind } from '@ethosagent/types';
import { splitJson, writeJson, writeJsonError } from '../json-output';

const USAGE = `Usage: ethos catalog <subcommand>

  list [--kind mcp|plugin|skill] [--json]          One line per entry: id  kind  tier  description
  search <query> [--kind mcp|plugin|skill] [--json] Case-insensitive match over id, name, description, publisher
  show <id> [--json]                               Full entry, pin, capabilities, install and grant commands
  install <id> [--arg K=V ...] [--env K=V ...] [-y] Install an entry by kind. Never grants anything
  grant <id> --personality <pid>                   Allow an installed catalog skill for one personality`;

/** What a subcommand produced; `runCatalog` prints it, tests read it. */
export interface CatalogCliResult {
  stdout: string[];
  stderr: string[];
  /** The `--json` document, present only in json mode. */
  json?: unknown;
  /** A failure under `--json`: `runCatalog` prints it with `writeJsonError`. */
  jsonError?: { code: string; message: string };
  code: number;
}

export function catalogFail(code: string, json: boolean, ...stderr: string[]): CatalogCliResult {
  return {
    stdout: [],
    stderr,
    code: 1,
    ...(json ? { jsonError: { code, message: stderr[0] ?? code } } : {}),
  };
}

function parseKind(args: string[]): { kind?: CatalogKind; rest: string[]; error?: string } {
  const rest = [...args];
  const at = rest.indexOf('--kind');
  if (at < 0) return { rest };
  const value = rest[at + 1];
  rest.splice(at, value === undefined ? 1 : 2);
  const kind = CATALOG_KINDS.find((k) => k === value);
  if (kind === undefined)
    return { rest, error: `--kind must be one of: ${CATALOG_KINDS.join(', ')}` };
  return { kind, rest };
}

function line(e: CatalogEntry): string {
  return `${e.id}  ${e.kind}  ${e.tier}  ${e.description}`;
}

function listing(entries: CatalogEntry[], json: boolean): CatalogCliResult {
  if (json) return { stdout: [], stderr: [], json: entries, code: 0 };
  return { stdout: entries.map(line), stderr: [], code: 0 };
}

/** Up to three ids close to `query`: filterCatalog first, then id substring either way. */
export function nearestIds(
  query: string,
  entries: readonly CatalogEntry[] = CATALOG_ENTRIES,
): string[] {
  const hits = filterCatalog(entries, { query }).map((e) => e.id);
  if (hits.length > 0) return hits.slice(0, 3);
  const q = query.toLowerCase();
  return entries
    .map((e) => e.id)
    .filter((id) => id.includes(q) || q.includes(id))
    .slice(0, 3);
}

/** `ethos catalog install <id>` with the flags a local MCP entry takes. */
function installCommand(e: CatalogEntry): string {
  return ['ethos catalog install', e.id, ...installFlags(e)].join(' ');
}

/** The grant command for `entry`'s kind; `catalog install` prints it and never runs it (D9). */
export function grantCommands(e: CatalogEntry): { grant: string[] } {
  if (e.kind === 'mcp') {
    return { grant: [`ethos personality mcp <personality-id> --attach ${e.id}`] };
  }
  if (e.kind === 'plugin') {
    return {
      grant: [`ethos personality plugins <personality-id> --attach ${e.plugin?.pluginId ?? e.id}`],
    };
  }
  return { grant: [`ethos catalog grant ${e.id} --personality <personality-id>`] };
}

/** The commands `catalog install` dispatches to, for doing it by hand. */
function byHand(e: CatalogEntry): string[] {
  if (e.kind === 'mcp') {
    return e.pin.type === 'remote'
      ? [`ethos mcp add ${e.id} --url ${e.pin.url}`]
      : [[`ethos mcp add ${e.id} --preset ${e.id}`, ...installFlags(e)].join(' ')];
  }
  if (e.kind === 'plugin') {
    const spec = e.pin.type === 'npm' ? `${e.pin.package}@${e.pin.version}` : e.id;
    return [`ethos plugin install ${spec}`];
  }
  return [];
}

function detail(e: CatalogEntry): string[] {
  const c = e.capabilities;
  const pin = e.pin;
  const pinLine =
    pin.type === 'remote'
      ? `remote ${pin.url} (${pin.transport})`
      : pin.type === 'git'
        ? `git ${pin.repo}@${pin.commit}${pin.subdir ? ` (${pin.subdir})` : ''}  ${pin.contentDigest}`
        : `${pin.type} ${pin.package}@${pin.version}  ${pin.integrity}`;
  const handInstall = byHand(e);
  const { grant } = grantCommands(e);
  return [
    `${e.name} (${e.id})`,
    `  kind:         ${e.kind}`,
    `  tier:         ${e.tier}`,
    `  publisher:    ${e.publisher}`,
    `  category:     ${e.category}`,
    `  description:  ${e.description}`,
    `  license:      ${e.license ?? 'n/a (remote service)'}`,
    ...(e.homepage ? [`  homepage:     ${e.homepage}`] : []),
    `  reviewed:     ${e.reviewedAt}`,
    `  pin:          ${pinLine}`,
    '  capabilities:',
    `    network:    ${c.network.length > 0 ? c.network.join(', ') : 'none'}`,
    `    auth:       ${c.auth}`,
    `    env:        ${c.env.length > 0 ? c.env.join(', ') : 'none'}`,
    `    filesystem: ${c.filesystem}`,
    `    shell:      ${c.shell ? 'yes' : 'no'}`,
    ...(c.toolCount !== undefined ? [`    tools:      ${c.toolCount}`] : []),
    '',
    'Install it:',
    `  ${installCommand(e)}`,
    ...(handInstall.length > 0 ? ['', 'Or by hand:', ...handInstall.map((c) => `  ${c}`)] : []),
    '',
    'Grant it to a personality:',
    ...grant.map((g) => `  ${g}`),
  ];
}

/** Pure: argv after `catalog` in, output and exit code out. */
export function execCatalog(argv: readonly string[]): CatalogCliResult {
  const { json, args } = splitJson(argv);
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list': {
      const k = parseKind(rest);
      if (k.error) return catalogFail('BAD_KIND', json, k.error);
      return listing(filterCatalog(CATALOG_ENTRIES, k.kind ? { kind: k.kind } : {}), json);
    }
    case 'search': {
      const k = parseKind(rest);
      if (k.error) return catalogFail('BAD_KIND', json, k.error);
      const query = k.rest.join(' ').trim();
      if (query === '')
        return catalogFail(
          'USAGE',
          json,
          'Usage: ethos catalog search <query> [--kind mcp|plugin|skill] [--json]',
        );
      return listing(
        filterCatalog(CATALOG_ENTRIES, { query, ...(k.kind ? { kind: k.kind } : {}) }),
        json,
      );
    }
    case 'show': {
      const id = rest[0];
      if (id === undefined)
        return catalogFail('USAGE', json, 'Usage: ethos catalog show <id> [--json]');
      const entry = CATALOG_ENTRIES.find((e) => e.id === id);
      if (!entry) {
        const near = nearestIds(id);
        return catalogFail(
          'NOT_FOUND',
          json,
          `Unknown catalog entry: ${id}`,
          ...(near.length > 0 ? [`Did you mean: ${near.join(', ')}`] : []),
        );
      }
      return json
        ? { stdout: [], stderr: [], json: entry, code: 0 }
        : { stdout: detail(entry), stderr: [], code: 0 };
    }
    case undefined:
    case 'help':
    case '--help':
      return { stdout: USAGE.split('\n'), stderr: [], code: 0 };
    default:
      return catalogFail('USAGE', json, `Unknown catalog subcommand: ${sub}`, USAGE);
  }
}

export async function runCatalog(argv: string[]): Promise<void> {
  const sub = splitJson(argv).args[0];
  let result: CatalogCliResult;
  if (sub === 'install' || sub === 'grant') {
    const m = await import('./catalog-install');
    const rest = splitJson(argv);
    const flat = [...rest.args.slice(1), ...(rest.json ? ['--json'] : [])];
    const deps = m.realCatalogInstallDeps();
    result = await (sub === 'install'
      ? m.execCatalogInstall(flat, deps)
      : m.execCatalogGrant(flat, deps));
  } else {
    result = execCatalog(argv);
  }
  if (result.json !== undefined) writeJson(result.json);
  for (const l of result.stdout) process.stdout.write(`${l}\n`);
  for (const l of result.stderr) process.stderr.write(`${l}\n`);
  // Same convention as `ethos commands show <unknown> --json`: one error doc
  // on stdout, exit 1. The human lines above stay on stderr.
  if (result.code !== 0 && result.jsonError) {
    writeJsonError(result.jsonError.code, result.jsonError.message, result.code);
  }
  if (result.code !== 0) process.exitCode = result.code;
}
