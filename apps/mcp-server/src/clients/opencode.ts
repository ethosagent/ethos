import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapter, McpEntry } from './types';

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
    servers.ethos = { type: 'local', command: [entry.command, ...entry.args] };
    return { ...config, mcp: { ...mcp, servers } };
  },

  serialise(config) {
    return JSON.stringify(config, null, 2);
  },
};
