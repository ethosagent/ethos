import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const cursor = {
    name: 'cursor',
    displayName: 'Cursor',
    configPath() {
        switch (process.platform) {
            case 'darwin':
                return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json');
            case 'win32':
                return join(process.env.APPDATA ?? homedir(), 'Cursor', 'User', 'mcp.json');
            default:
                return join(homedir(), '.config', 'cursor', 'mcp.json');
        }
    },
    readConfig(path) {
        if (!existsSync(path))
            return { mcpServers: {} };
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return { mcpServers: {} };
        }
    },
    injectEntry(config, entry) {
        const servers = (config.mcpServers ?? {});
        servers.ethos = { command: entry.command, args: entry.args };
        return { ...config, mcpServers: servers };
    },
    serialise(config) {
        return JSON.stringify(config, null, 2);
    },
};
