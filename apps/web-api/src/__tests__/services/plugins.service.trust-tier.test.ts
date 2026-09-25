// U10 (openclaw-9.6-gaps) — `plugins.list` carries each plugin's trust tier,
// read from the same install grant `ethos plugin grants` prints
// (`<dataDir>/plugins/grants.json`, `scan.tier`). No grant → null.

import { join } from 'node:path';
import { type PluginGrant, recordGrant } from '@ethosagent/plugin-loader';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { PluginsService } from '../../services/plugins.service';

const dataDir = '/data';
const pluginsDir = join(dataDir, 'plugins');

async function installManifest(storage: InMemoryStorage, name: string): Promise<void> {
  await storage.mkdir(join(pluginsDir, name));
  await storage.write(
    join(pluginsDir, name, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ethos: { type: 'plugin', pluginContractMajor: 2 } }),
  );
}

function grantFor(id: string): PluginGrant {
  return {
    id,
    package: id,
    version: '1.0.0',
    source: `npm:${id}@1.0.0`,
    capabilities: { shell: false, network: null },
    scan: { tier: 'community', findings: [], hasRed: false, hasYellow: false },
    grantedAt: '2026-09-01T00:00:00.000Z',
    consent: 'interactive',
  };
}

describe('PluginsService.list — trust tier', () => {
  it('reports the granted tier, and null for a plugin with no grant', async () => {
    const storage = new InMemoryStorage();
    await installManifest(storage, 'granted-plugin');
    await installManifest(storage, 'dropped-plugin');
    await recordGrant(storage, pluginsDir, grantFor('granted-plugin'));

    const { plugins } = await new PluginsService({ storage, dataDir }).list();
    const byId = Object.fromEntries(plugins.map((p) => [p.id, p.trustTier]));
    expect(byId).toEqual({ 'granted-plugin': 'community', 'dropped-plugin': null });
  });

  it('still lists plugins when grants.json is malformed', async () => {
    const storage = new InMemoryStorage();
    await installManifest(storage, 'granted-plugin');
    await storage.write(join(pluginsDir, 'grants.json'), '{not json');

    const { plugins } = await new PluginsService({ storage, dataDir }).list();
    expect(plugins.map((p) => [p.id, p.trustTier])).toEqual([['granted-plugin', null]]);
  });
});
