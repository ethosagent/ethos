import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BoundaryError } from '@ethosagent/types';
import { DEFAULT_LOG_LINES, listProcesses, markDeadRunningAsOrphan, readProcessLogs, STOP_SUPPORTED_SIGNALS, stopProcess, } from './operations';
import { isAlive, loadRegistry, saveRegistry, updateEntry, withRegistryLock, } from './registry';
import { spawnDetached } from './spawn';
import { buildLogFiles, compilePatterns, watchLogs } from './watcher';
// Default per-personality concurrency cap. The plan calls the cap
// "configurable" and floats a per-personality config field — but
// PersonalityConfig is a frozen schema, so we do NOT add a field there.
// `createProcessTools` accepts an optional `capMax` override for light
// configurability; per-personality cap *values* are deliberately deferred.
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_WAIT_TIMEOUT_S = 30;
const WAIT_POLL_MS = 200;
/**
 * Count running entries owned by `personalityId`. The cap applies per
 * personality, not globally — so one personality at the cap cannot starve
 * another.
 */
function runningCountFor(entries, personalityId) {
    return entries.filter((e) => e.status === 'running' && (e.started_by ?? 'unknown') === personalityId).length;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// process_start
// ---------------------------------------------------------------------------
function makeProcessStart(dataDir, capMax) {
    return {
        name: 'process_start',
        description: 'Start a long-running process in the background. Returns an id for tracking.',
        toolset: 'process',
        maxResultChars: 1024,
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run' },
                cwd: { type: 'string', description: 'Working directory (defaults to ctx.workingDir)' },
                env: {
                    type: 'object',
                    description: 'Extra environment variables',
                    additionalProperties: { type: 'string' },
                },
                name: { type: 'string', description: 'Human-friendly label for this process' },
            },
            required: ['command'],
        },
        async execute(args, ctx) {
            const { command, cwd, env, name } = args;
            if (!command)
                return { ok: false, error: 'command is required', code: 'input_invalid' };
            const id = randomUUID();
            // Resolve cwd to an absolute path ONCE. The same value is validated,
            // stored in the registry, and handed to spawnDetached — validating one
            // path and executing another (Node resolves a relative spawn cwd against
            // the parent process cwd, not ctx.workingDir) would be a boundary leak.
            // ctx.workingDir is absolute, so it is a sound base for a relative cwd.
            const effectiveCwd = cwd === undefined ? ctx.workingDir : resolve(ctx.workingDir, cwd);
            const effectiveName = name ?? command.slice(0, 40);
            const startedAt = new Date().toISOString();
            const startedBy = ctx.personalityId ?? 'unknown';
            // When an explicit cwd is given and a ScopedStorage is wired, probe it
            // through the personality's filesystem allowlist. A BoundaryError means
            // the cwd is outside the allowlist -> INVALID_CWD. `exists` is a read
            // probe: it returns false (not throws) for an in-allowlist path that is
            // simply absent, so a not-yet-created cwd is NOT treated as INVALID_CWD —
            // that case falls through to spawnDetached, which surfaces SPAWN_FAILED.
            if (cwd !== undefined && ctx.storage) {
                try {
                    await ctx.storage.exists(effectiveCwd);
                }
                catch (err) {
                    if (err instanceof BoundaryError) {
                        return {
                            ok: false,
                            error: `INVALID_CWD: ${effectiveCwd} is outside the personality filesystem allowlist`,
                            code: 'input_invalid',
                        };
                    }
                    throw err;
                }
            }
            // Cap-check + spawn + add run under ONE lock acquisition so two parallel
            // process_start calls can't both pass the cap-check and over-commit.
            return withRegistryLock(dataDir, () => {
                const registry = loadRegistry(dataDir);
                // Liveness sweep before the cap-check: entries still marked `running`
                // whose pid is dead would otherwise falsely consume cap slots (plan
                // principle #5 — liveness is observed, not trusted). Reuse the shared
                // dead->orphan rule; the swept registry is the one we keep mutating,
                // so the single saveRegistry below persists the orphan flips too.
                markDeadRunningAsOrphan(registry);
                const entries = Object.values(registry);
                if (runningCountFor(entries, startedBy) >= capMax) {
                    return {
                        ok: false,
                        error: `PROCESS_CAP_EXCEEDED: max ${capMax} concurrent processes per personality`,
                        code: 'execution_failed',
                    };
                }
                let pid;
                try {
                    const result = spawnDetached(id, command, effectiveCwd, env, dataDir);
                    pid = result.pid;
                }
                catch (err) {
                    return {
                        ok: false,
                        error: `SPAWN_FAILED: ${err instanceof Error ? err.message : String(err)}`,
                        code: 'execution_failed',
                    };
                }
                registry[id] = {
                    id,
                    name: effectiveName,
                    pid,
                    command,
                    cwd: effectiveCwd,
                    status: 'running',
                    startedAt,
                    lastTouchedAt: startedAt,
                    started_by: startedBy,
                };
                saveRegistry(dataDir, registry);
                return {
                    ok: true,
                    value: JSON.stringify({ id, pid, name: effectiveName, started_at: startedAt }),
                };
            });
        },
    };
}
// ---------------------------------------------------------------------------
// process_list
// ---------------------------------------------------------------------------
function makeProcessList(dataDir) {
    return {
        name: 'process_list',
        description: 'List all tracked processes with their current status.',
        toolset: 'process',
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: { type: 'object', properties: {} },
        async execute() {
            const items = await listProcesses(dataDir);
            return { ok: true, value: JSON.stringify(items, null, 2) };
        },
    };
}
// ---------------------------------------------------------------------------
// process_logs
// ---------------------------------------------------------------------------
function makeProcessLogs(dataDir) {
    return {
        name: 'process_logs',
        description: 'Return the last N lines from a process log. Interleaves stdout and stderr.',
        toolset: 'process',
        maxResultChars: 64_000,
        outputIsUntrusted: true,
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id' },
                lines: {
                    type: 'number',
                    description: `Number of lines to return (default ${DEFAULT_LOG_LINES})`,
                },
                stream: {
                    type: 'string',
                    enum: ['stdout', 'stderr', 'both'],
                    description: 'Which stream to read (default "both")',
                },
            },
            required: ['id'],
        },
        async execute(args) {
            const { id, lines, stream } = args;
            if (!id)
                return { ok: false, error: 'id is required', code: 'input_invalid' };
            const result = await readProcessLogs(dataDir, id, { lines, stream });
            if (!result.ok) {
                return { ok: false, error: result.error, code: 'execution_failed' };
            }
            if (result.lines.length === 0) {
                return { ok: true, value: '(no output)' };
            }
            return { ok: true, value: result.lines.join('\n') };
        },
    };
}
// ---------------------------------------------------------------------------
// process_stop
// ---------------------------------------------------------------------------
function makeProcessStop(dataDir) {
    return {
        name: 'process_stop',
        description: 'Send a signal to stop a running process.',
        toolset: 'process',
        maxResultChars: 1024,
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id' },
                signal: {
                    type: 'string',
                    enum: ['SIGTERM', 'SIGKILL'],
                    description: 'Signal to send (default "SIGTERM")',
                },
            },
            required: ['id'],
        },
        async execute(args) {
            const { id, signal } = args;
            if (!id)
                return { ok: false, error: 'id is required', code: 'input_invalid' };
            const sig = signal ?? 'SIGTERM';
            // The JSON schema constrains `signal` to an enum, but be defensive: a
            // caller bypassing schema validation must not reach process.kill with
            // an arbitrary signal name. stopProcess re-checks, but classifying the
            // error code as input_invalid (vs execution_failed) stays the tool's job.
            if (!STOP_SUPPORTED_SIGNALS.includes(sig)) {
                return {
                    ok: false,
                    error: `SIGNAL_NOT_SUPPORTED: signal ${sig} is not supported (use SIGTERM or SIGKILL)`,
                    code: 'input_invalid',
                };
            }
            const result = await stopProcess(dataDir, id, sig);
            if (!result.ok) {
                return { ok: false, error: result.error, code: 'execution_failed' };
            }
            return {
                ok: true,
                value: JSON.stringify({
                    stopped: result.stopped,
                    ...(result.exit_code !== undefined && { exit_code: result.exit_code }),
                }),
            };
        },
    };
}
// ---------------------------------------------------------------------------
// process_wait
// ---------------------------------------------------------------------------
function makeProcessWait(dataDir) {
    return {
        name: 'process_wait',
        description: 'Wait for a process to exit, up to timeout_s seconds.',
        toolset: 'process',
        maxResultChars: 1024,
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id' },
                timeout_s: {
                    type: 'number',
                    description: `Seconds to wait (default ${DEFAULT_WAIT_TIMEOUT_S})`,
                },
            },
            required: ['id'],
        },
        async execute(args, ctx) {
            const { id, timeout_s } = args;
            if (!id)
                return { ok: false, error: 'id is required', code: 'input_invalid' };
            const registry = loadRegistry(dataDir);
            const entry = registry[id];
            if (!entry) {
                return {
                    ok: false,
                    error: `PROCESS_NOT_FOUND: process ${id} not found`,
                    code: 'execution_failed',
                };
            }
            if (entry.status !== 'running') {
                return {
                    ok: true,
                    value: JSON.stringify({ exited: true, exit_code: entry.exitCode }),
                };
            }
            const timeoutMs = (timeout_s ?? DEFAULT_WAIT_TIMEOUT_S) * 1000;
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                // Respect the caller's abort signal to avoid blocking indefinitely
                if (ctx.abortSignal.aborted) {
                    return { ok: true, value: JSON.stringify({ exited: false, aborted: true }) };
                }
                await sleep(WAIT_POLL_MS);
                const current = loadRegistry(dataDir)[id];
                if (!current)
                    break;
                if (current.status !== 'running') {
                    return {
                        ok: true,
                        value: JSON.stringify({ exited: true, exit_code: current.exitCode }),
                    };
                }
                if (!isAlive(current.pid)) {
                    await updateEntry(dataDir, id, { status: 'orphan' });
                    return { ok: true, value: JSON.stringify({ exited: true }) };
                }
            }
            return { ok: true, value: JSON.stringify({ exited: false }) };
        },
    };
}
// ---------------------------------------------------------------------------
// process_watch
// ---------------------------------------------------------------------------
function makeProcessWatch(dataDir) {
    return {
        name: 'process_watch',
        description: 'Watch a background process log for pattern matches. ' +
            'Resolves on first match (default), timeout, or process exit.',
        toolset: 'process',
        maxResultChars: 4096,
        outputIsUntrusted: true,
        capabilities: {
            process: { allowedBinaries: ['*'] },
            fs_reach: { read: 'from-personality', write: 'from-personality' },
            storage: { scope: 'session', kind: 'kv' },
        },
        schema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Process id from process_start' },
                patterns: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Strings or /regex/ literals to match against each output line',
                },
                timeout_s: {
                    type: 'number',
                    description: 'Max seconds to wait (default 60)',
                },
                stop_on_first_match: {
                    type: 'boolean',
                    description: 'Resolve immediately on first match (default true)',
                },
                streams: {
                    type: 'string',
                    enum: ['stdout', 'stderr', 'both'],
                    description: 'Which streams to watch (default "both")',
                },
            },
            required: ['id', 'patterns'],
        },
        async execute(args, ctx) {
            const { id, patterns, timeout_s, stop_on_first_match, streams } = args;
            if (!id)
                return { ok: false, error: 'id is required', code: 'input_invalid' };
            if (!patterns || patterns.length === 0) {
                return {
                    ok: false,
                    error: 'patterns is required and must not be empty',
                    code: 'input_invalid',
                };
            }
            const registry = loadRegistry(dataDir);
            const entry = registry[id];
            if (!entry) {
                return {
                    ok: false,
                    error: `PROCESS_NOT_FOUND: process ${id} not found`,
                    code: 'execution_failed',
                };
            }
            if (entry.status !== 'running') {
                return {
                    ok: true,
                    value: JSON.stringify({
                        matched: false,
                        process_exited: true,
                        exit_code: entry.exitCode,
                    }),
                };
            }
            const result = compilePatterns(patterns);
            if ('error' in result) {
                return { ok: false, error: result.error, code: 'input_invalid' };
            }
            const logFiles = buildLogFiles(dataDir, id, streams ?? 'both');
            const watchResult = await watchLogs({
                id,
                pid: entry.pid,
                dataDir,
                logFiles,
                compiled: result.compiled,
                stopFirst: stop_on_first_match !== false,
                timeoutMs: (timeout_s ?? 60) * 1000,
                abortSignal: ctx.abortSignal,
                onMatch: (m) => {
                    ctx.emit({
                        type: 'progress',
                        toolName: 'process_watch',
                        message: `[${m.stream}] ${m.line}`,
                        audience: 'user',
                    });
                },
            });
            return { ok: true, value: JSON.stringify(watchResult) };
        },
    };
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createProcessTools(dataDir, opts) {
    // Guard the public option: a non-positive / non-integer capMax would either
    // disable the cap (NaN, Infinity) or wedge the tool (0, negative). Fall back
    // to the default rather than honoring a nonsensical value.
    const requested = opts?.capMax;
    const capMax = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
        ? requested
        : DEFAULT_MAX_CONCURRENT;
    return [
        makeProcessStart(dataDir, capMax),
        makeProcessList(dataDir),
        makeProcessLogs(dataDir),
        makeProcessStop(dataDir),
        makeProcessWait(dataDir),
        makeProcessWatch(dataDir),
    ];
}
export { checkCommand, createProcessGuardHook } from './guard';
// Re-export the shared list/logs/stop operations so the `ethos process` CLI
// can drive the same code path the tools use without constructing a fake
// ToolContext. Only the surface a real caller consumes is re-exported.
export { listProcesses, readProcessLogs, reconcileRegistry, STOP_SUPPORTED_SIGNALS, stopProcess, } from './operations';
export { saveRegistry } from './registry';
