import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir, readRawConfig } from '../config';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { buildVersionInfo } from '../version-info';
import { getStorage } from '../wiring';
// `ethos status` — single-pane health summary.
//
// Composes signals operators currently have to gather across four commands
// (doctor, cron list, mesh peers, config cat). Output is intentionally short:
// one line per facet, colour-coded by health. Exit 0 if everything green
// or yellow; exit non-zero only when something is structurally broken
// (no config, no provider, no personality) — same posture as `doctor`.
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
};
const G = `${c.green}✓${c.reset}`;
const W = `${c.yellow}!${c.reset}`;
const R = `${c.red}✗${c.reset}`;
const ETHOS_VERSION = typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');
export async function runStatus(cmdArgs = []) {
    const jsonMode = cmdArgs.includes('--json');
    let hardErrors = 0;
    if (!jsonMode) {
        console.log(`${c.bold}ethos${c.reset} ${c.dim}${ETHOS_VERSION}${c.reset}\n`);
    }
    // ---- Config ------------------------------------------------------------
    const storage = getStorage();
    const config = await readRawConfig(storage);
    if (!config) {
        if (jsonMode) {
            process.stdout.write(`${JSON.stringify({ version: buildVersionInfo(), config: { present: false }, adapters: [], personalities: { count: 0, dir: '' }, errorLog: { exists: false, recentCount: 0 }, exit: 1 })}\n`);
            process.exit(1);
        }
        console.log(`${R} ${c.bold}config${c.reset}        no ~/.ethos/config.yaml — run ${c.bold}ethos setup${c.reset}`);
        process.exit(1);
    }
    // ---- Personality data dir (shared data collection) -------------------
    const pdir = join(ethosDir(), 'personalities');
    const personalityCount = existsSync(pdir)
        ? readdirSync(pdir).filter((n) => !n.startsWith('.')).length
        : 0;
    // ---- Channel-filter (shared: may increment hardErrors) ---------------
    const adapterLines = adapterStatus(config);
    const channelFilters = countChannelFilters(config);
    if (channelFilters === 0 && adapterLines.length > 0) {
        hardErrors++;
    }
    // ---- JSON path -------------------------------------------------------
    if (jsonMode) {
        const result = {
            version: buildVersionInfo(),
            config: {
                present: true,
                provider: config.provider,
                model: config.model,
                personality: config.personality,
            },
            adapters: buildAdapterJson(config),
            personalities: { count: personalityCount, dir: pdir },
            errorLog: { exists: errorLogExists(), recentCount: readRecentErrors(10).length },
            exit: hardErrors > 0 ? 1 : 0,
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (hardErrors > 0)
            process.exit(1);
        return;
    }
    // ---- TTY path (unchanged from original) ------------------------------
    const cfgLine = `${G} ${c.bold}config${c.reset}        ${c.cyan}${config.provider}${c.reset} · ${config.model}` +
        ` · personality=${config.personality}` +
        (config.providers && config.providers.length > 0
            ? ` · fallback chain (${config.providers.length})`
            : '');
    console.log(cfgLine);
    // ---- Adapters configured ----------------------------------------------
    for (const line of adapterLines)
        console.log(line);
    // ---- Personality data dir -------------------------------------------
    if (existsSync(pdir)) {
        const ids = readdirSync(pdir).filter((n) => !n.startsWith('.'));
        console.log(`${G} ${c.bold}personalities${c.reset} ${ids.length} user-level + bundled ${c.dim}(${pdir})${c.reset}`);
    }
    else {
        console.log(`${W} ${c.bold}personalities${c.reset} no user-level dir at ${c.dim}${pdir}${c.reset} (only bundled visible)`);
    }
    // ---- Mesh registry ---------------------------------------------------
    const meshDir = join(ethosDir(), 'meshes');
    if (existsSync(meshDir)) {
        const meshes = readdirSync(meshDir).filter((n) => !n.startsWith('.'));
        const totalPeers = meshes.reduce((sum, m) => sum + countMeshPeers(join(meshDir, m)), 0);
        console.log(`${G} ${c.bold}mesh${c.reset}          ${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}` +
            `, ${totalPeers} registered agent${totalPeers === 1 ? '' : 's'} ${c.dim}(${meshDir})${c.reset}`);
    }
    else {
        console.log(`${c.dim}- mesh          no meshes${c.reset}`);
    }
    // ---- Cron ------------------------------------------------------------
    const cronDb = join(ethosDir(), 'cron', 'jobs.db');
    if (existsSync(cronDb)) {
        const s = statSync(cronDb);
        console.log(`${G} ${c.bold}cron${c.reset}          jobs.db present ${c.dim}(${(s.size / 1024).toFixed(1)} KB, modified ${s.mtime.toISOString().slice(0, 10)}; run ${c.reset}${c.bold}ethos cron list${c.dim} for counts)${c.reset}`);
    }
    else {
        console.log(`${c.dim}- cron          no scheduled jobs yet${c.reset}`);
    }
    // ---- MCP servers -----------------------------------------------------
    const mcpJson = join(ethosDir(), 'mcp.json');
    if (existsSync(mcpJson)) {
        const count = countMcpServers(mcpJson);
        console.log(`${G} ${c.bold}mcp${c.reset}           ${count} server${count === 1 ? '' : 's'} configured ${c.dim}(${mcpJson})${c.reset}`);
    }
    else {
        console.log(`${c.dim}- mcp           no servers configured${c.reset}`);
    }
    // ---- Messaging allowlist --------------------------------------------
    const messagingJson = join(ethosDir(), 'messaging.json');
    if (existsSync(messagingJson)) {
        const count = countMessagingEntries(messagingJson);
        console.log(`${G} ${c.bold}messaging${c.reset}     ${count} personality allowlist${count === 1 ? '' : 's'} ${c.dim}(${messagingJson})${c.reset}`);
    }
    else {
        console.log(`${c.dim}- messaging     no allowlists → send_message denied for all personalities${c.reset}`);
    }
    // ---- Channel-filter --------------------------------------------------
    if (channelFilters > 0) {
        console.log(`${G} ${c.bold}channel_filter${c.reset} ${channelFilters} platform${channelFilters === 1 ? '' : 's'} owner-gated`);
    }
    else if (adapterLines.length > 0) {
        console.log(`${R} ${c.bold}channel_filter${c.reset} adapters configured but no ${c.bold}channel_filter.<platform>.ownerUserId${c.reset} set — gateway will refuse to start`);
    }
    // ---- Recent errors --------------------------------------------------
    if (errorLogExists()) {
        const recent = readRecentErrors(10);
        if (recent.length === 0) {
            console.log(`${G} ${c.bold}errors${c.reset}        log present, no recent entries ${c.dim}(${errorLogPath()})${c.reset}`);
        }
        else {
            const latest = recent[recent.length - 1];
            const when = latest ? latest.ts.slice(0, 19).replace('T', ' ') : '';
            console.log(`${W} ${c.bold}errors${c.reset}        ${recent.length} recent entr${recent.length === 1 ? 'y' : 'ies'}` +
                (latest ? ` · latest ${c.dim}${when}${c.reset} ${c.cyan}${latest.code}${c.reset}` : '') +
                ` ${c.dim}(${errorLogPath()})${c.reset}`);
        }
    }
    else {
        console.log(`${c.dim}- errors        no error log written yet${c.reset}`);
    }
    // ---- Footer ---------------------------------------------------------
    console.log('');
    if (hardErrors > 0) {
        console.log(`${c.red}${hardErrors} blocking issue${hardErrors === 1 ? '' : 's'}.${c.reset} Run ${c.bold}ethos doctor${c.reset} for detailed diagnosis.`);
        process.exit(1);
    }
    console.log(`${c.dim}Run ${c.reset}${c.bold}ethos doctor${c.reset}${c.dim} for deeper diagnostics; ${c.reset}${c.bold}ethos cron list${c.reset}${c.dim} for cron details; ${c.reset}${c.bold}ethos logs${c.reset}${c.dim} for activity.${c.reset}`);
}
// ---------------------------------------------------------------------------
// Per-facet helpers
// ---------------------------------------------------------------------------
function adapterStatus(config) {
    const lines = [];
    // Telegram (legacy + multi-bot)
    const legacyTg = !!config.telegramToken;
    const tgBots = config.telegram?.bots ?? [];
    if (legacyTg || tgBots.length > 0) {
        const summary = legacyTg
            ? `legacy single bot${tgBots.length > 0 ? ` + ${tgBots.length} multi-bot` : ''}`
            : `${tgBots.length} bot${tgBots.length === 1 ? '' : 's'}`;
        lines.push(`${G} ${c.bold}telegram${c.reset}      ${summary}`);
    }
    // Slack (legacy + multi-app)
    const legacySlack = !!(config.slackBotToken && config.slackAppToken && config.slackSigningSecret);
    const slackApps = config.slack?.apps ?? [];
    if (legacySlack || slackApps.length > 0) {
        const summary = legacySlack
            ? `legacy single app${slackApps.length > 0 ? ` + ${slackApps.length} multi-app` : ''}`
            : `${slackApps.length} app${slackApps.length === 1 ? '' : 's'}`;
        lines.push(`${G} ${c.bold}slack${c.reset}         ${summary}`);
    }
    // Discord
    if (config.discordToken) {
        lines.push(`${G} ${c.bold}discord${c.reset}       configured`);
    }
    // Email
    if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
        lines.push(`${G} ${c.bold}email${c.reset}         IMAP+SMTP configured ${c.dim}(${config.emailUser})${c.reset}`);
    }
    return lines;
}
function buildAdapterJson(config) {
    const adapters = [];
    const tgConfigured = Boolean(config.telegramToken || (config.telegram?.bots?.length ?? 0) > 0);
    adapters.push({ name: 'telegram', configured: tgConfigured, ok: tgConfigured ? true : null });
    const slackConfigured = Boolean((config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
        (config.slack?.apps?.length ?? 0) > 0);
    adapters.push({ name: 'slack', configured: slackConfigured, ok: slackConfigured ? true : null });
    adapters.push({
        name: 'discord',
        configured: Boolean(config.discordToken),
        ok: config.discordToken ? true : null,
    });
    const emailConfigured = Boolean(config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost);
    adapters.push({ name: 'email', configured: emailConfigured, ok: emailConfigured ? true : null });
    return adapters;
}
function countChannelFilters(config) {
    let n = 0;
    if (config.channelFilter) {
        for (const cfg of Object.values(config.channelFilter)) {
            if (cfg && typeof cfg === 'object' && 'ownerUserId' in cfg && cfg.ownerUserId)
                n++;
        }
    }
    return n;
}
function countMeshPeers(meshDir) {
    const reg = join(meshDir, 'registry.json');
    if (!existsSync(reg))
        return 0;
    try {
        const parsed = JSON.parse(readFileSync(reg, 'utf-8'));
        return Array.isArray(parsed.agents) ? parsed.agents.length : 0;
    }
    catch {
        return 0;
    }
}
function countMcpServers(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return Array.isArray(parsed) ? parsed.length : 0;
    }
    catch {
        return 0;
    }
}
function countMessagingEntries(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).length : 0;
    }
    catch {
        return 0;
    }
}
