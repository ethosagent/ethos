import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientAdapter, McpEntry } from './types';

export const claudeDesktop: ClientAdapter = {
  name: 'claude-desktop',
  displayName: 'Claude Desktop',

  configPath() {
    switch (process.platform) {
      case 'darwin':
        return join(
          homedir(),
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        );
      case 'win32':
        return join(process.env.APPDATA ?? homedir(), 'Claude', 'claude_desktop_config.json');
      default:
        return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    }
  },

  readConfig(path) {
    if (!existsSync(path)) return { mcpServers: {} };
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { mcpServers: {} };
    }
  },

  injectEntry(config, entry: McpEntry) {
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers.ethos = { command: entry.command, args: entry.args };
    return { ...config, mcpServers: servers };
  },

  serialise(config) {
    return JSON.stringify(config, null, 2);
  },
};
