// `ethos catalog install <id>` and `ethos catalog grant <id> --personality <pid>`
// (plan/phases/unified-catalog.md §6.3 item 4, D9, D13).
//
// `install` resolves the entry, then dispatches to the install path that
// already exists for its kind and pin:
//
//   mcp  remote, auth none   -> addNoAuthRemoteServer (mcp.ts): the entry the
//                               web's mcp.addServer writes. `mcp add --url`
//                               cannot do this, it only does OAuth discovery.
//   mcp  remote, auth oauth  -> `ethos mcp add <id> --url <url>`
//   mcp  local (npm/pypi)    -> `ethos mcp add <id> --preset <id> --arg … --env …`
//   plugin                   -> installPlugin (plugin.ts) with the exact
//                               `pkg@version`; the catalog sha512 is compared
//                               with the scan prefix's tarball before consent.
//   skill                    -> installCatalogSkill (wiring)
//
// Nothing here grants (D9): the grant command for the kind is printed, never
// run. Every side effect sits behind `CatalogInstallDeps`, so
// __tests__/catalog-install-command.test.ts drives the dispatch with fakes and
// never touches ~/.ethos. Imports of the heavy modules are lazy for the same
// reason `ethos catalog list` must stay fast.

import { CATALOG_ENTRIES, catalogSkillPath } from '@ethosagent/catalog';
import { type CatalogEntry, EthosError } from '@ethosagent/types';
import { splitJson } from '../json-output';
import { type CatalogCliResult, catalogFail, grantCommands, nearestIds } from './catalog';

export const INSTALL_USAGE =
  'Usage: ethos catalog install <id> [--arg K=V ...] [--env K=V ...] [-y|--yes] [--json]';
export const GRANT_USAGE = 'Usage: ethos catalog grant <id> --personality <pid> [--json]';

export interface CatalogInstallDeps {
  /** Register a no-auth remote MCP server (mcp.ts `addNoAuthRemoteServer`). */
  addNoAuthRemote(name: string, url: string): Promise<void>;
  /** The `ethos mcp …` entry point (mcp.ts `runMcp`). */
  runMcp(argv: string[]): Promise<void>;
  /** plugin.ts `installPlugin` in catalog mode: throws typed EthosErrors, never exits, and with `json` never prompts. */
  installPlugin(
    spec: string,
    opts: { yes: boolean; integrity: string; tier: string; json: boolean },
  ): Promise<void>;
  /** wiring `installCatalogSkill` bound to the real storage and data dir. */
  installSkill(entry: CatalogEntry): Promise<{ installedAs: string }>;
  /** Add `catalog/<id>` to one personality's allow list; returns the whole list. */
  grantSkill(personalityId: string, entry: CatalogEntry): Promise<{ allow: string[] }>;
}

function errorLines(err: unknown): string[] {
  if (err instanceof EthosError) return [err.cause, `→ ${err.action}`];
  return [err instanceof Error ? err.message : String(err)];
}

function lookup(id: string | undefined, json: boolean, usage: string) {
  if (id === undefined || id.startsWith('-')) return { error: catalogFail('USAGE', json, usage) };
  const entry = CATALOG_ENTRIES.find((e) => e.id === id);
  if (!entry) {
    const near = nearestIds(id);
    return {
      error: catalogFail(
        'NOT_FOUND',
        json,
        `Unknown catalog entry: ${id}`,
        ...(near.length > 0 ? [`Did you mean: ${near.join(', ')}`] : []),
      ),
    };
  }
  return { entry };
}

/** `--arg K=V` / `--env K=V` pairs, in order, kept as `K=V` strings. */
function collectPairs(
  args: string[],
  flag: '--arg' | '--env',
): { pairs: string[]; error?: string } {
  const pairs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v === undefined || v.indexOf('=') < 1) {
      return { pairs, error: `${flag} needs KEY=VALUE` };
    }
    pairs.push(v);
    i++;
  }
  return { pairs };
}

export async function execCatalogInstall(
  argv: readonly string[],
  deps: CatalogInstallDeps,
): Promise<CatalogCliResult> {
  const { json, args } = splitJson(argv);
  const yes = args.includes('-y') || args.includes('--yes');
  const found = lookup(args[0], json, INSTALL_USAGE);
  if (found.error) return found.error;
  const entry = found.entry;
  const rest = args.slice(1);
  const argPairs = collectPairs(rest, '--arg');
  const envPairs = collectPairs(rest, '--env');
  if (argPairs.error || envPairs.error) {
    return catalogFail('USAGE', json, (argPairs.error ?? envPairs.error) as string, INSTALL_USAGE);
  }
  const isLocalMcp = entry.kind === 'mcp' && entry.pin.type !== 'remote';
  if (!isLocalMcp && (argPairs.pairs.length > 0 || envPairs.pairs.length > 0)) {
    return catalogFail(
      'USAGE',
      json,
      `--arg and --env apply to local MCP entries only; '${entry.id}' takes neither`,
    );
  }

  const stdout: string[] = [];
  try {
    const pin = entry.pin;
    if (entry.kind === 'mcp') {
      if (pin.type === 'remote') {
        if (entry.capabilities.auth === 'none') await deps.addNoAuthRemote(entry.id, pin.url);
        else if (entry.capabilities.auth === 'oauth')
          await deps.runMcp(['add', entry.id, '--url', pin.url]);
        else
          return catalogFail(
            'UNSUPPORTED',
            json,
            `'${entry.id}' needs a ${entry.capabilities.auth} credential that 'catalog install' cannot take`,
            `Run: ethos mcp add ${entry.id} --url ${pin.url}`,
          );
      } else {
        const unknownArg = argPairs.pairs.find(
          (p) => !(entry.mcp?.argVars ?? []).includes(p.slice(0, p.indexOf('='))),
        );
        const unknownEnv = envPairs.pairs.find(
          (p) => !(entry.mcp?.envVars ?? []).includes(p.slice(0, p.indexOf('='))),
        );
        if (unknownArg || unknownEnv) {
          return catalogFail(
            'USAGE',
            json,
            `Unknown ${unknownArg ? '--arg' : '--env'} ${(unknownArg ?? unknownEnv ?? '').split('=')[0]} for '${entry.id}'`,
            `Accepted: ${[...(entry.mcp?.argVars ?? []).map((v) => `--arg ${v}`), ...(entry.mcp?.envVars ?? []).map((v) => `--env ${v}`)].join(', ') || 'none'}`,
          );
        }
        await deps.runMcp([
          'add',
          entry.id,
          '--preset',
          entry.id,
          ...argPairs.pairs.flatMap((p) => ['--arg', p]),
          ...envPairs.pairs.flatMap((p) => ['--env', p]),
        ]);
      }
    } else if (entry.kind === 'plugin') {
      if (pin.type !== 'npm') {
        return catalogFail('UNSUPPORTED', json, `'${entry.id}' has no npm pin to install`);
      }
      await deps.installPlugin(`${pin.package}@${pin.version}`, {
        yes,
        integrity: pin.integrity,
        tier: entry.tier,
        json,
      });
    } else {
      const res = await deps.installSkill(entry);
      stdout.push(`Installed skill '${entry.id}' as ${res.installedAs}`);
    }
  } catch (err) {
    return catalogFail('INSTALL_FAILED', json, ...errorLines(err));
  }

  const { grant } = grantCommands(entry);
  stdout.push(
    '',
    'Nothing was granted. To give a personality access:',
    ...grant.map((g) => `  ${g}`),
  );
  return {
    stdout,
    stderr: [],
    code: 0,
    ...(json ? { json: { ok: true, id: entry.id, kind: entry.kind, grant } } : {}),
  };
}

export async function execCatalogGrant(
  argv: readonly string[],
  deps: CatalogInstallDeps,
): Promise<CatalogCliResult> {
  const { json, args } = splitJson(argv);
  const found = lookup(args[0], json, GRANT_USAGE);
  if (found.error) return found.error;
  const entry = found.entry;
  const at = args.indexOf('--personality');
  const personalityId = at >= 0 ? args[at + 1] : undefined;
  if (personalityId === undefined || personalityId.startsWith('-')) {
    return catalogFail('USAGE', json, GRANT_USAGE);
  }
  if (entry.kind !== 'skill') {
    return catalogFail(
      'UNSUPPORTED',
      json,
      `'${entry.id}' is a ${entry.kind} entry; 'catalog grant' is for skills`,
      `Use: ${grantCommands(entry).grant.join(' ; ')}`,
    );
  }
  try {
    const { allow } = await deps.grantSkill(personalityId, entry);
    return {
      stdout: [
        `Granted catalog/${entry.id} to ${personalityId} (skills.global_ingest.allow: ${allow.join(', ')})`,
        "It appears on the personality's next turn.",
      ],
      stderr: [],
      code: 0,
      ...(json ? { json: { ok: true, allow } } : {}),
    };
  } catch (err) {
    return catalogFail('GRANT_FAILED', json, ...errorLines(err));
  }
}

/** The real seams. Lazy imports keep `ethos catalog list` from loading wiring and the plugin loader. */
export function realCatalogInstallDeps(): CatalogInstallDeps {
  return {
    addNoAuthRemote: async (name, url) => {
      const { addNoAuthRemoteServer } = await import('./mcp');
      await addNoAuthRemoteServer(name, url);
    },
    runMcp: async (argv) => {
      const { runMcp } = await import('./mcp');
      await runMcp(argv);
    },
    installPlugin: async (spec, opts) => {
      const { installPlugin } = await import('./plugin');
      await installPlugin(spec, undefined, opts.yes, {
        integrity: opts.integrity,
        tier: opts.tier,
        json: opts.json,
      });
    },
    installSkill: async (entry) => {
      const { installCatalogSkill } = await import('@ethosagent/wiring');
      const { ethosDir } = await import('@ethosagent/config');
      const { getStorage } = await import('../wiring');
      return installCatalogSkill(entry, { storage: getStorage(), dataDir: ethosDir() });
    },
    grantSkill: async (personalityId, entry) => {
      const { createPersonalityRegistry, setCatalogSkillGrant } = await import(
        '@ethosagent/wiring'
      );
      const { ethosDir } = await import('@ethosagent/config');
      const { getStorage } = await import('../wiring');
      const { join } = await import('node:path');
      const storage = getStorage();
      const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
      await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
      // The same function `catalog.setSkillGrant` uses (wiring catalog-install.ts).
      return setCatalogSkillGrant(
        entry,
        { personalityId, granted: true },
        {
          personalities: {
            get: (id) => {
              const d = reg.describe(id);
              return d
                ? { builtin: d.builtin, allow: d.config.skills?.global_ingest?.allow ?? [] }
                : undefined;
            },
            setAllow: async (id, allow) => {
              await reg.update(id, { skills: { global_ingest: { allow } } });
            },
          },
          skillInstalled: (id) => storage.exists(catalogSkillPath(ethosDir(), id)),
        },
      );
    },
  };
}
