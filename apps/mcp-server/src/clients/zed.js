import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const zed = {
    name: 'zed',
    displayName: 'Zed',
    configPath() {
        switch (process.platform) {
            case 'darwin':
                return join(homedir(), 'Library', 'Application Support', 'Zed', 'settings.json');
            case 'win32':
                return join(process.env.APPDATA ?? homedir(), 'Zed', 'settings.json');
            default:
                return join(homedir(), '.config', 'zed', 'settings.json');
        }
    },
    readConfig(path) {
        if (!existsSync(path))
            return { context_servers: {} };
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return { context_servers: {} };
        }
    },
    injectEntry(config, entry) {
        const servers = (config.context_servers ?? {});
        servers.ethos = {
            command: {
                path: entry.command,
                args: entry.args,
            },
        };
        return { ...config, context_servers: servers };
    },
    serialise(config) {
        return JSON.stringify(config, null, 2);
    },
};
