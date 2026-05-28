import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const opencode = {
  name: 'opencode',
  displayName: 'OpenCode',
  configPath() {
    return join(homedir(), '.config', 'opencode', 'config.json');
  },
  readConfig(path) {
    if (!existsSync(path)) return { mcp: { servers: {} } };
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { mcp: { servers: {} } };
    }
  },
  injectEntry(config, entry) {
    const mcp = config.mcp ?? {};
    const servers = mcp.servers ?? {};
    servers.ethos = { type: 'local', command: [entry.command, ...entry.args] };
    return { ...config, mcp: { ...mcp, servers } };
  },
  serialise(config) {
    return JSON.stringify(config, null, 2);
  },
};
