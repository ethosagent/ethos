import { launcherArgs } from '@ethosagent/catalog/filter';
import type {
  CatalogEntryInfo,
  McpAddServerInput,
  McpLocalPresetInfo,
  McpRemotePresetInfo,
} from '@ethosagent/web-contracts';

// Pure logic shared by `AddMcpModal`'s "Preset" mode and `CatalogBrowser`
// (plan/phases/mcp-inline-catalog.md) — relocated out of `AddMcpModal.tsx`
// (where it originally lived and was exported) so a second consumer doesn't
// have to import a component file for its logic. No JSX, no DOM — matches
// the convention of `apps/web/src/lib/attachmentLists.ts`.

/** Auth badge copy for a remote catalog entry. */
export function authBadgeLabel(authType: McpRemotePresetInfo['authType']): string {
  if (authType === 'oauth') return 'OAuth';
  if (authType === 'none') return 'No auth';
  return 'API key';
}

/** Bucket catalog entries by `category`, preserving the order the server sent. */
export function groupByCategory<T extends { category: string }>(
  items: readonly T[],
): { category: string; items: T[] }[] {
  const groups: { category: string; items: T[] }[] = [];
  for (const item of items) {
    const existing = groups.find((g) => g.category === item.category);
    if (existing) existing.items.push(item);
    else groups.push({ category: item.category, items: [item] });
  }
  return groups;
}

/** What a remote catalog entry submits, decided by its `authType`. */
export function buildRemoteSubmission(
  preset: McpRemotePresetInfo,
  token: string,
):
  | { kind: 'oauth'; input: { url: string } }
  | { kind: 'addServer'; input: Extract<McpAddServerInput, { transport: 'streamable-http' }> } {
  if (preset.authType === 'oauth') {
    return { kind: 'oauth', input: { url: preset.url } };
  }
  if (preset.authType === 'none') {
    return {
      kind: 'addServer',
      input: {
        name: preset.name,
        url: preset.url,
        transport: 'streamable-http',
        authType: 'none',
      },
    };
  }
  const trimmed = token.trim();
  return {
    kind: 'addServer',
    input: {
      name: preset.name,
      url: preset.url,
      transport: 'streamable-http',
      authType: 'bearer',
      ...(trimmed ? { token: trimmed } : {}),
    },
  };
}

/**
 * Split catalog entries by how they authenticate, for the onboarding
 * Connectors step (plan keyless-first-run §5.2). Derived from `authType` at
 * render time so there is no second hand-kept list: `none` rows connect with
 * one click, `oauth` rows need a sign-in. `bearer` rows need a pasted key, so
 * they appear in neither group. Input order is preserved.
 */
export function groupByAuth<T extends { authType: McpRemotePresetInfo['authType'] }>(
  items: readonly T[],
): { none: T[]; oauth: T[] } {
  return {
    none: items.filter((i) => i.authType === 'none'),
    oauth: items.filter((i) => i.authType === 'oauth'),
  };
}

/**
 * The preset shapes the Add-MCP modal and the onboarding Connectors step
 * consume, rebuilt from `catalog.list({ kind: 'mcp' })` entries. This replaces
 * the deprecated `mcp.catalog` read (plan unified-catalog §9) and reproduces
 * `McpService.catalog()` field by field: remote presets are the `remote`-pinned
 * entries, local presets the npm/pypi-pinned entries that carry `mcp` data
 * (command = npx | uvx, args = `launcherArgs` + `argsAfterSpec`, exactly as
 * `MCP_PRESETS` derives them), both sorted by name. Entries that fit neither
 * (a remote with `env` auth, or a non-MCP kind) are skipped. Pinned against the
 * frozen mcp-catalog-golden.json by `__tests__/catalog.test.ts`.
 *
 * TEMPORARY: delete when the modal and step consume `CatalogEntry` directly,
 * at `mcp.catalog` removal (plan unified-catalog §9).
 */
export function presetsFromCatalog(entries: readonly CatalogEntryInfo[]): {
  remote: McpRemotePresetInfo[];
  local: McpLocalPresetInfo[];
} {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const remote: McpRemotePresetInfo[] = [];
  const local: McpLocalPresetInfo[] = [];
  for (const e of entries) {
    if (e.kind !== 'mcp') continue;
    const { pin, capabilities: caps } = e;
    if (pin.type === 'remote') {
      if (caps.auth === 'env') continue;
      remote.push({
        name: e.id,
        label: e.name,
        url: pin.url,
        transport: pin.transport,
        authType: caps.auth,
        description: e.description,
        category: e.category,
        ...(e.homepage ? { docsUrl: e.homepage } : {}),
      });
    } else if ((pin.type === 'npm' || pin.type === 'pypi') && e.mcp) {
      local.push({
        name: e.id,
        description: e.description,
        command: pin.type === 'npm' ? 'npx' : 'uvx',
        args: [...launcherArgs(pin), ...e.mcp.argsAfterSpec],
        envVars: [...e.mcp.envVars],
        argVars: [...e.mcp.argVars],
        category: e.category,
        pin: {
          registry: pin.type,
          package: pin.package,
          version: pin.version,
          integrity: pin.integrity,
        },
      });
    }
  }
  return { remote: remote.sort(byName), local: local.sort(byName) };
}
