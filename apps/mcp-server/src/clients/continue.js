import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const continueClient = {
    name: 'continue',
    displayName: 'Continue',
    configPath() {
        return join(homedir(), '.continue', 'config.json');
    },
    readConfig(path) {
        if (!existsSync(path))
            return { mcpServers: [] };
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return { mcpServers: [] };
        }
    },
    injectEntry(config, entry) {
        const servers = (config.mcpServers ?? []);
        const filtered = servers.filter((s) => s.name !== 'ethos');
        filtered.push({ name: 'ethos', command: entry.command, args: entry.args });
        return { ...config, mcpServers: filtered };
    },
    serialise(config) {
        return JSON.stringify(config, null, 2);
    },
};
