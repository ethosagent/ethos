// ---------------------------------------------------------------------------
// Install records — the grant draft and the personality pin an install leaves
// ---------------------------------------------------------------------------
//
// Two surfaces install a plugin: `ethos plugin install` (`installPlugin` in
// `apps/ethos/src/commands/plugin.ts`) and the web `PluginsService.install`
// (`apps/web-api/src/services/plugins.service.ts`). Both build the consent
// grant with `draftPluginGrant` and write the `plugins.lock` entry with
// `pinPluginToPersonality`, so the same act leaves the same state behind
// whichever surface performed it. Do not assemble a `PluginGrant` or a
// `PluginLockEntry` for an install anywhere else.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import type { PluginScanPermissions } from '@ethosagent/safety-scanner';
import type { Storage } from '@ethosagent/types';
import {
  derivePluginId,
  type PluginGrant,
  type PluginGrantCapabilities,
  type PluginGrantScan,
} from './grants';
import {
  computeIntegrity,
  DEFAULT_REGISTRY,
  type PluginLockEntry,
  readLockfile,
  writeLockfile,
} from './lockfile';

/** A grant before consent is taken: everything except when and how. */
export type PluginGrantDraft = Omit<PluginGrant, 'grantedAt' | 'consent'>;

/** Extract `ethos.permissions` from an already-parsed package.json object. */
export function readPluginPermissions(pkgJson: unknown): PluginScanPermissions {
  if (pkgJson === null || typeof pkgJson !== 'object') return {};
  const ethos = (pkgJson as Record<string, unknown>).ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return {};
  const perms = (ethos as Record<string, unknown>).permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return {};
  const p = perms as Record<string, unknown>;
  const result: PluginScanPermissions = {};
  if (p.shell === true) result.shell = true;
  if (Array.isArray(p.network)) {
    result.network = p.network.filter((x): x is string => typeof x === 'string');
  } else if (p.network === true) {
    result.network = []; // declared but no host restriction
  }
  return result;
}

export interface DraftPluginGrantInput {
  /** The installed package's parsed package.json; `undefined` when unreadable. */
  pkgJson: unknown;
  /** The spec the operator asked for — used wherever package.json is silent. */
  requestedSpec: string;
  /** The scan result as it stood at install, recorded verbatim. */
  scan: PluginGrantScan;
}

/**
 * Build the grant for an installed package, plus the exact `name@version` spec
 * it resolved to. Capabilities are the package's declared `ethos.permissions`;
 * the id is the one the loader resolves (`derivePluginId`), so a revocation
 * recorded against it is the one the loader looks up.
 */
export function draftPluginGrant(input: DraftPluginGrantInput): {
  draft: PluginGrantDraft;
  exactSpec: string;
} {
  const meta = (
    input.pkgJson !== null && typeof input.pkgJson === 'object' ? input.pkgJson : {}
  ) as { name?: unknown; version?: unknown };
  const metaName = typeof meta.name === 'string' && meta.name ? meta.name : undefined;
  const metaVersion = typeof meta.version === 'string' && meta.version ? meta.version : undefined;
  const pkgName = metaName ?? input.requestedSpec;
  const exactSpec = metaName && metaVersion ? `${metaName}@${metaVersion}` : input.requestedSpec;
  const permissions = readPluginPermissions(input.pkgJson);

  return {
    draft: {
      id: derivePluginId(input.pkgJson, pkgName),
      package: pkgName,
      version: metaVersion ?? 'unknown',
      source: `npm:${exactSpec}`,
      capabilities: {
        shell: permissions.shell === true,
        network: permissions.network ?? null,
      } satisfies PluginGrantCapabilities,
      scan: input.scan,
    },
    exactSpec,
  };
}

export interface PinPluginToPersonalityInput {
  storage: Storage;
  /** The npm prefix the package was installed under — `<dataDir>/plugins`. */
  pluginsDir: string;
  /** `<dataDir>/personalities/<id>`. */
  personalityDir: string;
  draft: PluginGrantDraft;
}

/**
 * Pin an installed plugin in a personality's `plugins.lock` and add its id to
 * the personality's `plugins:` line — the latter only when its `config.yaml`
 * exists (`updatePersonalityPluginConfig` returns early otherwise). Returns the
 * entry written.
 *
 * `integrity` is `computeIntegrity` of the INSTALLED `package.json`, not of the
 * tarball, and nothing on the install or load path calls `verifyIntegrity`
 * against it. That is a known gap tracked as FU-1 in
 * `plan/phases/trust-before-reach.md`; it is recorded here unchanged.
 */
export async function pinPluginToPersonality(
  input: PinPluginToPersonalityInput,
): Promise<PluginLockEntry> {
  const { storage, pluginsDir, personalityDir, draft } = input;
  const integrity = await computeIntegrity(
    join(pluginsDir, 'node_modules', draft.package, 'package.json'),
  );
  const entry: PluginLockEntry = {
    package: draft.package,
    version: draft.version,
    registry: DEFAULT_REGISTRY,
    integrity,
  };
  await updatePersonalityPluginConfig(storage, personalityDir, draft.id, entry);
  return entry;
}

export async function updatePersonalityPluginConfig(
  storage: Storage,
  personalityDir: string,
  pluginId: string,
  entry: PluginLockEntry,
): Promise<void> {
  const lockfile = await readLockfile(storage, personalityDir);
  lockfile[pluginId] = entry;
  await writeLockfile(storage, personalityDir, lockfile);

  const configPath = join(personalityDir, 'config.yaml');
  const configContent = await storage.read(configPath);
  if (!configContent) return;

  const lines = configContent.split('\n');
  const pluginsIdx = lines.findIndex((l) => l.startsWith('plugins:'));

  if (pluginsIdx >= 0) {
    const existing = lines[pluginsIdx].replace('plugins:', '').trim();
    const ids = existing ? existing.split(/\s+/) : [];
    if (!ids.includes(pluginId)) {
      ids.push(pluginId);
      lines[pluginsIdx] = `plugins: ${ids.join(' ')}`;
    }
  } else {
    lines.push(`plugins: ${pluginId}`);
  }

  await storage.write(configPath, lines.join('\n'));
}
