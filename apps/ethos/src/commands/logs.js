import { join } from 'node:path';
import { ethosDir } from '../config';
import { writeJson } from '../json-output';
import { getStorage } from '../wiring';
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};
function logsRoot() {
    return join(ethosDir(), 'logs');
}
function parseFlags(args) {
    let out;
    let lines = 120;
    let intervalMs = 1000;
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? '';
        if (a === '--out') {
            out = args[i + 1];
            i++;
            continue;
        }
        if (a === '--lines') {
            const n = Number(args[i + 1]);
            if (Number.isFinite(n) && n > 0)
                lines = Math.floor(n);
            i++;
            continue;
        }
        if (a === '--interval-ms') {
            const n = Number(args[i + 1]);
            if (Number.isFinite(n) && n >= 200)
                intervalMs = Math.floor(n);
            i++;
        }
    }
    return { out, lines, intervalMs };
}
async function listTailTargets() {
    const storage = getStorage();
    const root = logsRoot();
    const targets = [
        join(root, 'errors.jsonl'),
        join(root, 'mesh-supervisor.log'),
        join(root, 'gateway.out.log'),
        join(root, 'gateway.err.log'),
        join(root, 'notes.log'),
    ];
    const teamRoot = join(root, 'team');
    if (!(await storage.exists(teamRoot)))
        return targets;
    const teams = await storage.listEntries(teamRoot);
    for (const team of teams) {
        if (!team.isDir)
            continue;
        const teamDir = join(teamRoot, team.name);
        const files = await storage.listEntries(teamDir);
        for (const file of files) {
            if (file.isDir)
                continue;
            targets.push(join(teamDir, file.name));
        }
    }
    return targets;
}
function pathLabel(path) {
    const root = logsRoot();
    if (path.startsWith(`${root}/`))
        return path.slice(root.length + 1);
    return path;
}
function printPrefixed(path, block) {
    for (const line of block.split('\n')) {
        const trimmed = line.trimEnd();
        if (!trimmed)
            continue;
        console.log(`${c.dim}[${pathLabel(path)}]${c.reset} ${trimmed}`);
    }
}
async function readTail(path, lines) {
    const storage = getStorage();
    const raw = await storage.read(path);
    if (!raw)
        return '';
    const parts = raw.split('\n');
    const tail = parts.slice(-lines);
    return tail.join('\n').trim();
}
function summarizeErrors(raw) {
    const byCode = new Map();
    if (!raw)
        return { total: 0, byCode };
    let total = 0;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const row = JSON.parse(trimmed);
            const code = row.code?.trim();
            if (!code)
                continue;
            total += 1;
            byCode.set(code, (byCode.get(code) ?? 0) + 1);
        }
        catch {
            // Ignore malformed lines so one bad entry does not hide the rest.
        }
    }
    return { total, byCode };
}
function summarizeSupervisor(raw) {
    const byEvent = new Map();
    if (!raw)
        return { total: 0, byEvent };
    let total = 0;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const row = JSON.parse(trimmed);
            const event = row.event?.trim();
            if (!event)
                continue;
            total += 1;
            byEvent.set(event, (byEvent.get(event) ?? 0) + 1);
        }
        catch {
            // Ignore malformed lines.
        }
    }
    return { total, byEvent };
}
function printMapRows(title, rows) {
    const ordered = [...rows.entries()].sort((a, b) => b[1] - a[1]);
    if (ordered.length === 0) {
        console.log(`  ${c.dim}${title}: none${c.reset}`);
        return;
    }
    console.log(`  ${title}:`);
    for (const [k, count] of ordered) {
        console.log(`    ${String(count).padStart(5)}  ${k}`);
    }
}
function statusMark(exists) {
    return exists ? `${c.green}✓${c.reset}` : `${c.yellow}–${c.reset}`;
}
async function runList(json) {
    const storage = getStorage();
    const root = logsRoot();
    const files = [
        'errors.jsonl',
        'errors.jsonl.1',
        'mesh-supervisor.log',
        'gateway.out.log',
        'gateway.err.log',
        'notes.log',
    ];
    if (json) {
        const result = [];
        for (const name of files) {
            const path = join(root, name);
            const exists = await storage.exists(path);
            result.push({ path, exists });
        }
        writeJson(result);
        return;
    }
    console.log(`\n${c.bold}ethos logs${c.reset}  ${c.dim}paths${c.reset}\n`);
    console.log(`  root: ${c.cyan}${root}${c.reset}`);
    for (const name of files) {
        const path = join(root, name);
        const exists = await storage.exists(path);
        console.log(`  ${statusMark(exists)}  ${name.padEnd(20)} ${c.dim}${path}${c.reset}`);
    }
    const teamDir = join(root, 'team');
    const teamDirExists = await storage.exists(teamDir);
    console.log(`  ${statusMark(teamDirExists)}  team/                ${c.dim}${teamDir}${c.reset}`);
    if (teamDirExists) {
        const teams = await storage.listEntries(teamDir);
        const onlyDirs = teams.filter((t) => t.isDir);
        if (onlyDirs.length > 0) {
            const names = onlyDirs.map((d) => d.name).join(', ');
            console.log(`      ${c.dim}teams: ${names}${c.reset}`);
        }
    }
    console.log('');
    console.log(`  ${c.dim}Note: daemon manager logs may also live outside ~/.ethos/logs (pm2/journald).${c.reset}`);
    console.log('');
}
async function runSummary(json) {
    const storage = getStorage();
    const root = logsRoot();
    const errorsPath = join(root, 'errors.jsonl');
    const supervisorPath = join(root, 'mesh-supervisor.log');
    const errors = summarizeErrors(await storage.read(errorsPath));
    const supervisor = summarizeSupervisor(await storage.read(supervisorPath));
    if (json) {
        writeJson({
            errorCount: errors.total,
            errorsByCode: Object.fromEntries(errors.byCode),
            supervisorEvents: supervisor.total,
            supervisorEventsByType: Object.fromEntries(supervisor.byEvent),
        });
        return;
    }
    console.log(`\n${c.bold}ethos logs${c.reset}  ${c.dim}summary${c.reset}\n`);
    console.log(`  errors: ${errors.total}`);
    printMapRows('by code', errors.byCode);
    console.log('');
    console.log(`  supervisor events: ${supervisor.total}`);
    printMapRows('by event', supervisor.byEvent);
    console.log('');
}
async function runNote() {
    const storage = getStorage();
    const root = logsRoot();
    const errorsPath = join(root, 'errors.jsonl');
    const supervisorPath = join(root, 'mesh-supervisor.log');
    const notesPath = join(root, 'notes.log');
    const errors = summarizeErrors(await storage.read(errorsPath));
    const supervisor = summarizeSupervisor(await storage.read(supervisorPath));
    const topError = [...errors.byCode.entries()].sort((a, b) => b[1] - a[1])[0];
    const topEvent = [...supervisor.byEvent.entries()].sort((a, b) => b[1] - a[1])[0];
    const line = `${new Date().toISOString()} ` +
        `errors=${errors.total}` +
        `${topError ? ` top_error=${topError[0]}:${topError[1]}` : ''} ` +
        `supervisor_events=${supervisor.total}` +
        `${topEvent ? ` top_event=${topEvent[0]}:${topEvent[1]}` : ''}`;
    await storage.mkdir(root);
    await storage.append(notesPath, `${line.trim()}\n`);
    console.log(`\n${c.green}✓${c.reset} Wrote log note:`);
    console.log(`  ${c.dim}${notesPath}${c.reset}`);
    console.log(`  ${line.trim()}\n`);
}
async function runBundle(flags) {
    const storage = getStorage();
    const root = logsRoot();
    const out = flags.out ??
        join(root, 'bundles', `ethos-support-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    const errorsPath = join(root, 'errors.jsonl');
    const supervisorPath = join(root, 'mesh-supervisor.log');
    const gatewayOutPath = join(root, 'gateway.out.log');
    const gatewayErrPath = join(root, 'gateway.err.log');
    const notesPath = join(root, 'notes.log');
    const chunks = [];
    chunks.push(`# Ethos Support Bundle`);
    chunks.push(`generated_at: ${new Date().toISOString()}`);
    chunks.push('');
    const errorsRaw = await storage.read(errorsPath);
    const supervisorRaw = await storage.read(supervisorPath);
    const errors = summarizeErrors(errorsRaw);
    const supervisor = summarizeSupervisor(supervisorRaw);
    chunks.push('## Summary');
    chunks.push(`errors_total: ${errors.total}`);
    for (const [code, count] of [...errors.byCode.entries()].sort((a, b) => b[1] - a[1])) {
        chunks.push(`error.${code}: ${count}`);
    }
    chunks.push(`supervisor_events_total: ${supervisor.total}`);
    for (const [event, count] of [...supervisor.byEvent.entries()].sort((a, b) => b[1] - a[1])) {
        chunks.push(`supervisor.${event}: ${count}`);
    }
    const sections = [
        { title: 'errors.jsonl (tail)', path: errorsPath },
        { title: 'mesh-supervisor.log (tail)', path: supervisorPath },
        { title: 'gateway.err.log (tail)', path: gatewayErrPath },
        { title: 'gateway.out.log (tail)', path: gatewayOutPath },
        { title: 'notes.log (tail)', path: notesPath },
    ];
    for (const section of sections) {
        chunks.push('');
        chunks.push(`## ${section.title}`);
        chunks.push(`path: ${section.path}`);
        const tail = await readTail(section.path, flags.lines);
        chunks.push(tail || '(missing or empty)');
    }
    await storage.mkdir(join(root, 'bundles'));
    await storage.writeAtomic(out, `${chunks.join('\n')}\n`);
    console.log(`\n${c.green}✓${c.reset} Wrote support bundle:`);
    console.log(`  ${c.dim}${out}${c.reset}\n`);
}
async function runTail(flags) {
    const storage = getStorage();
    const sizes = new Map();
    let polling = false;
    async function refreshTargets(initial) {
        const targets = await listTailTargets();
        for (const path of targets) {
            if (sizes.has(path))
                continue;
            const raw = await storage.read(path);
            const content = raw ?? '';
            sizes.set(path, content.length);
            if (initial) {
                const lines = content.split('\n').slice(-flags.lines).join('\n').trim();
                if (lines) {
                    printPrefixed(path, lines);
                }
            }
            else {
                console.log(`${c.dim}[watch] discovered ${pathLabel(path)}${c.reset}`);
            }
        }
    }
    async function pollOnce() {
        if (polling)
            return;
        polling = true;
        try {
            await refreshTargets(false);
            for (const [path, previousSize] of sizes) {
                const raw = await storage.read(path);
                const content = raw ?? '';
                const currentSize = content.length;
                if (currentSize < previousSize) {
                    console.log(`${c.yellow}[watch] rotated ${pathLabel(path)}${c.reset}`);
                    const tail = content.split('\n').slice(-flags.lines).join('\n').trim();
                    if (tail)
                        printPrefixed(path, tail);
                    sizes.set(path, currentSize);
                    continue;
                }
                if (currentSize > previousSize) {
                    const delta = content.slice(previousSize);
                    printPrefixed(path, delta);
                    sizes.set(path, currentSize);
                }
            }
        }
        finally {
            polling = false;
        }
    }
    await refreshTargets(true);
    console.log(`\n${c.bold}ethos logs${c.reset}  ${c.dim}tail${c.reset}  ${c.dim}(Ctrl+C to stop; interval ${flags.intervalMs}ms)${c.reset}\n`);
    await new Promise((resolve) => {
        const timer = setInterval(() => {
            void pollOnce();
        }, flags.intervalMs);
        const stop = () => {
            clearInterval(timer);
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            console.log(`\n${c.dim}Stopped log tail.${c.reset}`);
            resolve();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    });
}
export async function runLogs(args) {
    const sub = (args[0] ?? 'list').toLowerCase();
    const rest = args.slice(1);
    const flags = parseFlags(rest);
    const json = args.includes('--json');
    switch (sub) {
        case 'list':
            await runList(json);
            return;
        case 'summary':
            await runSummary(json);
            return;
        case 'note':
            await runNote();
            return;
        case 'bundle':
            await runBundle(flags);
            return;
        case 'tail':
            await runTail(flags);
            return;
        case 'help':
        case '--help':
        case '-h':
            break;
        default:
            console.error(`Unknown logs subcommand: ${sub}`);
            break;
    }
    console.log('Usage: ethos logs [list | summary | note | bundle [--out <path>] [--lines <n>] | tail [--lines <n>] [--interval-ms <n>]]');
}
