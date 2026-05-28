// ethos personality export <id> — produce a shareable tar.gz of one personality
//
// Exports SOUL.md, config.yaml, toolset.yaml, skills/**, and non-secret MCP
// config. Strips secrets (tokens, keys) and personal state (MEMORY.md, USER.md,
// kanban.db, dream-state.json). Generates a secrets.manifest.yaml so the
// recipient knows which credentials to fill in.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { ethosDir } from '../config';
import { getStorage } from '../wiring';
import { writeTarGz } from './backup';
const MCP_TOKEN_FILENAMES = new Set(['access_token', 'refresh_token', 'expires_at']);
const MCP_EXPORT_ALLOWLIST = new Set(['config.yaml']);
const KNOWN_SECRET_FIELDS = new Set([
    'anthropicapikey',
    'openaiapikey',
    'telegramtoken',
    'telegrambottoken',
    'discordtoken',
    'discordbottoken',
    'slackbottoken',
    'slackapptoken',
    'slacksigningsecret',
    'emailpassword',
]);
const SECRET_FIELD_DISPLAY = {
    anthropicapikey: {
        key: 'ANTHROPIC_API_KEY',
        description: 'Anthropic API key for LLM inference',
        fillWith: 'ethos keys set anthropic-api-key <value>',
    },
    openaiapikey: {
        key: 'OPENAI_API_KEY',
        description: 'OpenAI API key for LLM inference',
        fillWith: 'ethos keys set openai-api-key <value>',
    },
    telegramtoken: {
        key: 'TELEGRAM_TOKEN',
        description: 'Telegram bot token',
        fillWith: 'ethos secrets set telegram-token <value>',
    },
    telegrambottoken: {
        key: 'TELEGRAM_BOT_TOKEN',
        description: 'Telegram bot token',
        fillWith: 'ethos secrets set telegram-bot-token <value>',
    },
    discordtoken: {
        key: 'DISCORD_TOKEN',
        description: 'Discord bot token',
        fillWith: 'ethos secrets set discord-token <value>',
    },
    discordbottoken: {
        key: 'DISCORD_BOT_TOKEN',
        description: 'Discord bot token',
        fillWith: 'ethos secrets set discord-bot-token <value>',
    },
    slackbottoken: {
        key: 'SLACK_BOT_TOKEN',
        description: 'Slack bot OAuth token',
        fillWith: 'ethos secrets set slack-bot-token <value>',
    },
    slackapptoken: {
        key: 'SLACK_APP_TOKEN',
        description: 'Slack app-level token',
        fillWith: 'ethos secrets set slack-app-token <value>',
    },
    slacksigningsecret: {
        key: 'SLACK_SIGNING_SECRET',
        description: 'Slack signing secret for request verification',
        fillWith: 'ethos secrets set slack-signing-secret <value>',
    },
    emailpassword: {
        key: 'EMAIL_PASSWORD',
        description: 'Email account password for IMAP/SMTP',
        fillWith: 'ethos secrets set email-password <value>',
    },
};
// Case-insensitive substrings that flag a config field as a secret reference
const SECRET_FIELD_PATTERNS = ['token', 'key', 'secret'];
const USAGE = 'Usage: ethos personality export <id> [--output <path>]';
function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------
/** Top-level files to include from the personality directory. */
const INCLUDE_FILES = new Set(['SOUL.md', 'config.yaml', 'toolset.yaml']);
function collectPersonalityEntries(personalityDir, id) {
    const entries = [];
    const prefix = join('personalities', id);
    // Top-level included files
    for (const file of INCLUDE_FILES) {
        const p = join(personalityDir, file);
        if (existsSync(p)) {
            entries.push({ relPath: join(prefix, file), content: readFileSync(p) });
        }
    }
    // skills/ directory (recursive)
    const skillsDir = join(personalityDir, 'skills');
    if (existsSync(skillsDir)) {
        const skillsSt = lstatSync(skillsDir);
        if (!skillsSt.isSymbolicLink() && skillsSt.isDirectory()) {
            collectDirRecursive(skillsDir, join(prefix, 'skills'), entries);
        }
    }
    // mcp/ directory — config.yaml only, skip token files
    const mcpDir = join(personalityDir, 'mcp');
    if (existsSync(mcpDir)) {
        const mcpSt = lstatSync(mcpDir);
        if (!mcpSt.isSymbolicLink() && mcpSt.isDirectory()) {
            collectMcpEntries(mcpDir, prefix, entries);
        }
    }
    return entries;
}
function collectDirRecursive(dir, relPrefix, entries) {
    for (const name of readdirSync(dir)) {
        const fullPath = join(dir, name);
        const st = lstatSync(fullPath);
        if (st.isSymbolicLink())
            continue;
        if (st.isDirectory()) {
            collectDirRecursive(fullPath, join(relPrefix, name), entries);
        }
        else if (st.isFile()) {
            entries.push({ relPath: join(relPrefix, name), content: readFileSync(fullPath) });
        }
    }
}
function collectMcpEntries(mcpDir, prefix, entries) {
    for (const serverName of readdirSync(mcpDir)) {
        const serverDir = join(mcpDir, serverName);
        const serverSt = lstatSync(serverDir);
        if (serverSt.isSymbolicLink() || !serverSt.isDirectory())
            continue;
        for (const file of readdirSync(serverDir)) {
            const filePath = join(serverDir, file);
            const fileSt = lstatSync(filePath);
            if (fileSt.isSymbolicLink() || !fileSt.isFile())
                continue;
            // Only include known safe config files
            if (!MCP_EXPORT_ALLOWLIST.has(file))
                continue;
            entries.push({
                relPath: join(prefix, 'mcp', serverName, file),
                content: readFileSync(filePath),
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Secrets manifest generation
// ---------------------------------------------------------------------------
function scanConfigForSecrets(personalityDir) {
    const configPath = join(personalityDir, 'config.yaml');
    if (!existsSync(configPath))
        return [];
    const content = readFileSync(configPath, 'utf8');
    const found = [];
    for (const line of content.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0)
            continue;
        const fieldName = line.slice(0, colonIdx).trim();
        const lower = fieldName.toLowerCase();
        if (KNOWN_SECRET_FIELDS.has(lower)) {
            if (!found.includes(lower))
                found.push(lower);
            continue;
        }
        // Check partial matches (field contains Token, Key, or Secret)
        for (const pattern of SECRET_FIELD_PATTERNS) {
            if (lower.includes(pattern)) {
                if (!found.includes(lower))
                    found.push(lower);
                break;
            }
        }
    }
    return found;
}
function scanMcpForStrippedServers(personalityDir) {
    const mcpDir = join(personalityDir, 'mcp');
    if (!existsSync(mcpDir))
        return [];
    const mcpSt = lstatSync(mcpDir);
    if (mcpSt.isSymbolicLink() || !mcpSt.isDirectory())
        return [];
    const stripped = [];
    for (const serverName of readdirSync(mcpDir)) {
        const serverDir = join(mcpDir, serverName);
        const serverSt = lstatSync(serverDir);
        if (serverSt.isSymbolicLink() || !serverSt.isDirectory())
            continue;
        for (const file of readdirSync(serverDir)) {
            if (MCP_TOKEN_FILENAMES.has(file)) {
                stripped.push(serverName);
                break;
            }
        }
    }
    return stripped;
}
function buildSecretsManifest(id, personalityDir) {
    const secretFields = scanConfigForSecrets(personalityDir);
    const strippedServers = scanMcpForStrippedServers(personalityDir);
    if (secretFields.length === 0 && strippedServers.length === 0)
        return null;
    const lines = [
        '# Generated by ethos personality export',
        '# Fill these secrets before using this personality',
        `personality: ${id}`,
        `exported_at: ${new Date().toISOString()}`,
    ];
    if (secretFields.length > 0) {
        lines.push('');
        lines.push('secrets:');
        for (const field of secretFields) {
            const display = SECRET_FIELD_DISPLAY[field];
            if (display) {
                lines.push(`  - key: ${display.key}`);
                lines.push(`    description: ${display.description}`);
                lines.push(`    fill_with: "${display.fillWith}"`);
            }
            else {
                // Unknown secret field — emit a generic entry
                lines.push(`  - key: ${field}`);
                lines.push(`    description: Secret field "${field}" (stripped from export)`);
                lines.push(`    fill_with: "ethos secrets set ${field} <value>"`);
            }
        }
    }
    if (strippedServers.length > 0) {
        lines.push('');
        lines.push('mcp_auth:');
        for (const name of strippedServers) {
            lines.push(`  - server: ${name}`);
            lines.push(`    description: OAuth token for MCP server "${name}" (stripped from export)`);
            lines.push(`    fill_with: "ethos mcp auth ${name}"`);
        }
    }
    lines.push('');
    return lines.join('\n');
}
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
export { runPersonalityImport } from './backup';
export async function runPersonalityExport(argv) {
    // Parse args: first positional = id, --output <path>
    let id;
    let outputPath;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--output' && argv[i + 1]) {
            outputPath = argv[i + 1];
            i++;
        }
        else if (arg && !arg.startsWith('-') && !id) {
            id = arg;
        }
    }
    if (!id) {
        console.error(USAGE);
        process.exitCode = 1;
        return;
    }
    const dataDir = ethosDir();
    const personalitiesDir = join(dataDir, 'personalities');
    // Validate personality exists
    const storage = getStorage();
    const reg = await createPersonalityRegistry(storage);
    await reg.loadFromDirectory(personalitiesDir);
    const personality = reg.get(id);
    if (!personality) {
        const known = reg
            .list()
            .map((p) => p.id)
            .sort();
        console.error(`Personality "${id}" not found.`);
        if (known.length > 0) {
            console.error(`Known personalities: ${known.join(', ')}`);
        }
        process.exitCode = 1;
        return;
    }
    const personalityDir = join(personalitiesDir, id);
    if (!existsSync(personalityDir)) {
        console.error(`Personality directory not found: ${personalityDir}`);
        process.exitCode = 1;
        return;
    }
    // Collect files
    const entries = collectPersonalityEntries(personalityDir, id);
    // Generate secrets manifest
    const manifest = buildSecretsManifest(id, personalityDir);
    if (manifest) {
        entries.push({
            relPath: 'secrets.manifest.yaml',
            content: Buffer.from(manifest, 'utf8'),
        });
    }
    if (entries.length === 0) {
        console.log(`Nothing to export for personality "${id}".`);
        return;
    }
    // Write archive
    const outPath = outputPath ?? `ethos-personality-${id}-${timestamp()}-${randomBytes(4).toString('hex')}.tar.gz`;
    await writeTarGz(entries, outPath);
    console.log(`Exported personality "${id}" to: ${outPath} (${entries.length} files)`);
}
