// Testable implementations of `ethos evolve status` and `ethos evolve apply`.
// These accept an explicit `ethosDir` string so tests can inject a temp dir
// without mocking the module-level `ethosDir()` function.
import { readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
};
function parseLastRecord(raw) {
    const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0)
        return null;
    const last = lines[lines.length - 1];
    if (!last)
        return null;
    try {
        return JSON.parse(last);
    }
    catch {
        return null;
    }
}
export async function runEvolveStatus(_args, ethosDir) {
    const historyPath = join(ethosDir, 'evolver-history.jsonl');
    const skillsDir = join(ethosDir, 'skills');
    const pendingDir = join(skillsDir, 'pending');
    // Read history
    let lastRecord = null;
    try {
        const raw = await readFile(historyPath, 'utf-8');
        lastRecord = parseLastRecord(raw);
    }
    catch {
        // No history yet
    }
    // Read pending files
    let pendingFiles = [];
    try {
        const entries = await readdir(pendingDir);
        pendingFiles = entries.filter((e) => e.endsWith('.md')).sort();
    }
    catch {
        // No pending dir
    }
    if (!lastRecord && pendingFiles.length === 0) {
        console.log(`${c.dim}No proposals yet. Run: ethos evolve run${c.reset}`);
        return;
    }
    if (lastRecord) {
        const ranAt = new Date(lastRecord.ranAt).toLocaleString();
        const proposed = (lastRecord.rewritesProposed ?? 0) + (lastRecord.newSkillsProposed ?? 0);
        const skipped = Array.isArray(lastRecord.skipped) ? lastRecord.skipped.length : 0;
        console.log(`${c.bold}Last run:${c.reset} ${ranAt}`);
        console.log(`  ${c.dim}proposed: ${proposed}  skipped: ${skipped}${c.reset}`);
        console.log('');
    }
    if (pendingFiles.length === 0) {
        console.log(`${c.dim}No pending proposals.${c.reset}`);
        return;
    }
    console.log(`${c.bold}Pending (${pendingFiles.length}):${c.reset}`);
    for (const f of pendingFiles) {
        console.log(`  ${f}`);
    }
    console.log('');
    console.log(`Approve with: ${c.bold}ethos evolve apply <filename>${c.reset}  or  ${c.bold}ethos evolve apply --all${c.reset}`);
}
// ---------------------------------------------------------------------------
// ethos evolve apply <skill-id>  |  ethos evolve apply --all [-y]
// ---------------------------------------------------------------------------
function ensureSafeFilename(name) {
    if (!name.endsWith('.md'))
        return null;
    if (name.includes('/') || name.includes('\\') || name.includes('..'))
        return null;
    return name;
}
export async function runEvolveApply(args, ethosDir) {
    const skillsDir = join(ethosDir, 'skills');
    const pendingDir = join(skillsDir, 'pending');
    const applyAll = args.includes('--all');
    if (applyAll) {
        let entries;
        try {
            entries = await readdir(pendingDir);
        }
        catch {
            console.log(`${c.dim}No pending skills.${c.reset}`);
            return;
        }
        const mds = entries.filter((e) => e.endsWith('.md'));
        if (mds.length === 0) {
            console.log(`${c.dim}No pending skills.${c.reset}`);
            return;
        }
        for (const f of mds) {
            await rename(join(pendingDir, f), join(skillsDir, f));
            console.log(`${c.green}approved${c.reset} ${f}`);
        }
        return;
    }
    // Single file
    const fileName = args.find((a) => !a.startsWith('-'));
    if (!fileName) {
        console.error(`${c.red}Usage: ethos evolve apply <filename.md> | --all${c.reset}`);
        process.exit(1);
    }
    const safe = ensureSafeFilename(fileName);
    if (!safe) {
        console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
        process.exit(1);
    }
    try {
        await stat(join(pendingDir, safe));
        await rename(join(pendingDir, safe), join(skillsDir, safe));
        console.log(`${c.green}approved${c.reset} ${safe}`);
    }
    catch {
        console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
        process.exit(1);
    }
}
