import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type ClientAdapter, entryName, type McpEntry } from './types';

export const opencode: ClientAdapter = {
  name: 'opencode',
  displayName: 'OpenCode',

  configPath() {
    return join(homedir(), '.config', 'opencode', 'config.json');
  },

  readConfig(path) {
    if (!existsSync(path)) return { mcp: { servers: {} } };
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { mcp: { servers: {} } };
    }
  },

  injectEntry(config, entry: McpEntry) {
    const mcp = (config.mcp ?? {}) as Record<string, unknown>;
    const servers = (mcp.servers ?? {}) as Record<string, unknown>;
    // OpenCode names the env block `environment` on a local server, not `env`.
    servers[entryName(entry)] = {
      type: 'local',
      command: [entry.command, ...entry.args],
      ...(entry.env ? { environment: entry.env } : {}),
    };
    return { ...config, mcp: { ...mcp, servers } };
  },

  serialise(config) {
    return JSON.stringify(config, null, 2);
  },
};
