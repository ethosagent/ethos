import { CATALOG_ENTRIES, catalogSkillPath, installFlags } from '@ethosagent/catalog';
import { type CatalogEntry, type CatalogKind, EthosError } from '@ethosagent/types';
import type {
  CatalogAction,
  CatalogInstallOutput,
  CatalogListOutput,
  CatalogSetSkillGrantOutput,
} from '@ethosagent/web-contracts';
import { setCatalogSkillGrant } from '@ethosagent/wiring';

// CatalogService — `catalog.list` (plan/phases/unified-catalog.md §5.2).
//
// Reads the in-repo index and decorates each entry with `installed` and
// `action` (D10). It writes nothing and imports no extension: the three
// "what is already here" reads are injected by `createWebApi`, so the web-api
// gains no app -> extension edge (archcheck `l5-apps-through-wiring`).
// Output shape pinned by `CatalogListOutputSchema` in the service test.
//
// `install` and `setSkillGrant` (plan §6.4) are the only writers. Both take
// their effects through injected seams (`installPlugin`, `installSkill`,
// `personalities`), so this file still imports no extension. An install never
// grants (D9); `setSkillGrant` edits only the `skills.global_ingest.allow` of
// one non-built-in personality. Failures are typed `EthosError`s (D18), pinned
// by __tests__/services/catalog-install.test.ts.

export interface CatalogServiceOptions {
  /** Names in mcp.json (the store `McpService` already reads). */
  listMcpNames: () => Promise<string[]>;
  /** Installed plugins; called only when the index holds a plugin entry. */
  listInstalledPlugins: () => Promise<Array<{ id: string; name: string }>>;
  /** Whether `<dataDir>/catalog-skills/<id>` exists; see `catalogSkillInstalled`. */
  skillInstalled: (id: string) => Promise<boolean>;
  /** The index to serve; defaults to the shipped entries. Tests pass synthetic ones. */
  entries?: readonly CatalogEntry[];
  /** `installCatalogPlugin` bound to this server's PluginsService (wiring). Absent -> NOT_CONFIGURED. */
  installPlugin?: (entry: CatalogEntry) => Promise<{ installedAs: string }>;
  /** `installCatalogSkill` bound to this server's storage and data dir (wiring). Absent -> NOT_CONFIGURED. */
  installSkill?: (entry: CatalogEntry) => Promise<{ installedAs: string }>;
  /** The personality registry's read and `skills.global_ingest.allow` write. Absent -> NOT_CONFIGURED. */
  personalities?: {
    get(id: string): { builtin: boolean; allow: string[] } | undefined;
    setAllow(id: string, allow: string[]): Promise<void>;
  };
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

  private find(id: string): CatalogEntry {
    const entry = (this.opts.entries ?? CATALOG_ENTRIES).find((e) => e.id === id);
    if (!entry) {
      throw new EthosError({
        code: 'CATALOG_ENTRY_NOT_FOUND',
        cause: `The catalog has no entry '${id}'`,
        action: 'Refresh the catalog, or run: ethos catalog search <query>',
      });
    }
    return entry;
  }

  private async isInstalled(entry: CatalogEntry): Promise<boolean> {
    if (entry.kind === 'skill') return this.opts.skillInstalled(entry.id);
    if (entry.kind === 'plugin' && entry.pin.type === 'npm') {
      const pkg = entry.pin.package;
      return (await this.opts.listInstalledPlugins()).some((p) => p.name === pkg);
    }
    return false;
  }

  /** `catalog.install`: a plugin or skill entry. MCP entries keep `mcp.addServer` / `mcp.start` (D18). */
  async install(input: { id: string }): Promise<CatalogInstallOutput> {
    const entry = this.find(input.id);
    if (entry.kind === 'mcp') {
      const a = actionFor(entry);
      const path =
        a.type === 'add'
          ? 'Add it with mcp.addServer (the Add button on the MCP page).'
          : a.type === 'oauth'
            ? 'Connect it with mcp.start (the Connect button on the MCP page).'
            : `Run it from a terminal: ${a.type === 'cli' ? a.command : `ethos catalog install ${entry.id}`}`;
      throw new EthosError({
        code: 'CATALOG_INSTALL_UNSUPPORTED',
        cause: `'${entry.id}' is an MCP server; catalog.install does not install MCP servers`,
        action: path,
        details: { action: a },
      });
    }
    const install = entry.kind === 'plugin' ? this.opts.installPlugin : this.opts.installSkill;
    if (!install) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: `This server was started without a ${entry.kind} installer`,
        action: `Install from a terminal: ethos catalog install ${entry.id}`,
      });
    }
    if (await this.isInstalled(entry)) {
      throw new EthosError({
        code: 'CATALOG_ALREADY_INSTALLED',
        cause: `'${entry.id}' is already installed`,
        action: 'Nothing to do.',
      });
    }
    const { installedAs } = await install(entry);
    return {
      ok: true,
      kind: entry.kind,
      id: entry.id,
      installedAs,
      grantHint:
        entry.kind === 'plugin'
          ? 'Attach it on the Plugins page'
          : `Grant it to a personality from the Skills page, or: ethos catalog grant ${entry.id} --personality <id>`,
    };
  }

  /** `catalog.setSkillGrant`: add or remove `catalog/<id>` in ONE personality's `skills.global_ingest.allow`. */
  async setSkillGrant(input: {
    personalityId: string;
    id: string;
    granted: boolean;
  }): Promise<CatalogSetSkillGrantOutput> {
    const entry = this.find(input.id);
    const personalities = this.opts.personalities;
    if (!personalities) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'This server was started without a personality registry',
        action: 'Grant from a terminal: ethos catalog grant <id> --personality <pid>',
      });
    }
    const { allow } = await setCatalogSkillGrant(
      entry,
      { personalityId: input.personalityId, granted: input.granted },
      { personalities, skillInstalled: this.opts.skillInstalled },
    );
    return { ok: true, allow };
  }
}
