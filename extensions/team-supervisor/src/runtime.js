import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export function teamsDir() {
    return join(homedir(), '.ethos', 'teams');
}
export function runtimePath(name) {
    return join(teamsDir(), `${name}.runtime.json`);
}
export function pidFilePath(name) {
    return join(teamsDir(), `${name}.pid`);
}
export function teamLogDir(name) {
    return join(homedir(), '.ethos', 'logs', 'team', name);
}
export function writeRuntime(state) {
    const path = runtimePath(state.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
export function readRuntime(name) {
    try {
        const src = readFileSync(runtimePath(name), 'utf-8');
        return JSON.parse(src);
    }
    catch {
        return null;
    }
}
/**
 * Read a runtime file from a non-default teams root. Test harnesses and any
 * caller that wires a custom teams dir (e.g. `KanbanService({ teamsDir })`)
 * must use this to keep manifest, board, and runtime reads consistent.
 */
export function readRuntimeFrom(rootDir, name) {
    try {
        const src = readFileSync(join(rootDir, `${name}.runtime.json`), 'utf-8');
        return JSON.parse(src);
    }
    catch {
        return null;
    }
}
export function removeRuntime(name) {
    try {
        unlinkSync(runtimePath(name));
    }
    catch {
        /* ignore */
    }
}
