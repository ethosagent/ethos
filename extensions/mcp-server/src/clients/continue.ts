import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapter, McpEntry } from './types';

export const continueClient: ClientAdapter = {
  name: 'continue',
  displayName: 'Continue',

  configPath() {
    return join(homedir(), '.continue', 'config.json');
  },

  readConfig(path) {
    if (!existsSync(path)) return { mcpServers: [] };
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { mcpServers: [] };
    }
  },

  injectEntry(config, entry: McpEntry) {
    const servers = (config.mcpServers ?? []) as Array<Record<string, unknown>>;
    const filtered = servers.filter((s) => s.name !== 'ethos');
    filtered.push({ name: 'ethos', command: entry.command, args: entry.args });
    return { ...config, mcpServers: filtered };
  },

  serialise(config) {
    return JSON.stringify(config, null, 2);
  },
};
