import { CATALOG_ENTRIES, catalogSkillPath, installFlags } from '@ethosagent/catalog';
import type { CatalogEntry, CatalogKind } from '@ethosagent/types';
import type { CatalogAction, CatalogListOutput } from '@ethosagent/web-contracts';

// CatalogService — `catalog.list` (plan/phases/unified-catalog.md §5.2).
//
// Reads the in-repo index and decorates each entry with `installed` and
// `action` (D10). It writes nothing and imports no extension: the three
// "what is already here" reads are injected by `createWebApi`, so the web-api
// gains no app -> extension edge (archcheck `l5-apps-through-wiring`).
// Output shape pinned by `CatalogListOutputSchema` in the service test.

export interface CatalogServiceOptions {
  /** Names in mcp.json (the store `McpService` already reads). */
  listMcpNames: () => Promise<string[]>;
  /** Installed plugins; called only when the index holds a plugin entry. */
  listInstalledPlugins: () => Promise<Array<{ id: string; name: string }>>;
  /** Whether `<dataDir>/catalog-skills/<id>` exists; see `catalogSkillInstalled`. */
  skillInstalled: (id: string) => Promise<boolean>;
  /** The index to serve; defaults to the shipped entries. Tests pass synthetic ones. */
  entries?: readonly CatalogEntry[];
}

/**
 * The skill check `createWebApi` injects: `catalogSkillPath(dataDir, id)`
 * (D16) through the Storage abstraction. Phase 3 creates that directory;
 * until then the index has no skill entries and this is never asked.
 * Limitation: it only tests that the directory exists, not that its contents
 * match the catalog pin.
 */
export function catalogSkillInstalled(
  storage: { exists(path: string): Promise<boolean> },
  dataDir: string,
): (id: string) => Promise<boolean> {
  return (id) => storage.exists(catalogSkillPath(dataDir, id));
}

/** `ethos catalog install <id> --arg NAME=<name> ... --env KEY=<key> ...` for a local entry. */
function cliCommand(entry: CatalogEntry): string {
  return ['ethos catalog install', entry.id, ...installFlags(entry)].join(' ');
}

export function actionFor(entry: CatalogEntry): CatalogAction {
  if (entry.kind !== 'mcp') return { type: 'install' };
  if (entry.pin.type === 'remote') {
    if (entry.capabilities.auth === 'oauth') {
      return { type: 'oauth', url: entry.pin.url, name: entry.id };
    }
    // `mcp.addServer` registers a URL and nothing else. A bearer or env
    // credential has nowhere to go from a one-click add, so those entries get
    // the CLI form: `mcp add` has no token flag, the token is supplied with
    // `ethos personality mcp <id> --attach <name> --token-stdin`.
    if (entry.capabilities.auth === 'none') {
      return { type: 'add', name: entry.id, url: entry.pin.url };
    }
    return { type: 'cli', command: `ethos mcp add ${entry.id} --url ${entry.pin.url}` };
  }
  return { type: 'cli', command: cliCommand(entry) };
}

export class CatalogService {
  constructor(private readonly opts: CatalogServiceOptions) {}

  async list(input: { kind?: CatalogKind } = {}): Promise<CatalogListOutput> {
    const entries = (this.opts.entries ?? CATALOG_ENTRIES).filter(
      (e) => input.kind === undefined || e.kind === input.kind,
    );
    const has = (kind: CatalogKind) => entries.some((e) => e.kind === kind);
    // Independent reads, each only when the set holds that kind.
    const [mcpNames, plugins, skills] = await Promise.all([
      has('mcp') ? this.opts.listMcpNames() : Promise.resolve([]),
      has('plugin') ? this.opts.listInstalledPlugins() : Promise.resolve([]),
      Promise.all(
        entries
          .filter((e) => e.kind === 'skill')
          .map(async (e) => [e.id, await this.opts.skillInstalled(e.id)] as const),
      ),
    ]);
    const mcpSet = new Set(mcpNames);
    const skillSet = new Set(skills.filter(([, ok]) => ok).map(([id]) => id));
    return {
      version: 1,
      entries: entries.map((e) => {
        let installed = false;
        if (e.kind === 'mcp') installed = mcpSet.has(e.id);
        // Identity is the pinned npm package against the installed plugin's
        // full package name; an unscoped lookalike must not count.
        else if (e.kind === 'plugin') {
          const pin = e.pin;
          installed = pin.type === 'npm' && plugins.some((p) => p.name === pin.package);
        } else installed = skillSet.has(e.id);
        return { ...e, installed, action: actionFor(e) };
      }),
    };
  }
}
