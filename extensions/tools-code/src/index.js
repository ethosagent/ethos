import { stripAnsiEscapes } from '@ethosagent/core';
const DEFAULT_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// Runtime definitions
// ---------------------------------------------------------------------------
const RUNTIMES = {
    python: { image: 'python:3.12-slim', cmd: ['python3', '-'] },
    js: { image: 'node:22-slim', cmd: ['node', '--input-type=module'] },
    bash: { image: 'bash:5.2', cmd: ['bash', '-s'] },
};
const RUNTIME_NAMES = Object.keys(RUNTIMES).join(', ');
// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------
function createRunCodeTool(sandbox) {
    return {
        name: 'run_code',
        description: `Run code in an isolated Docker container. Supported runtimes: ${RUNTIME_NAMES}. No network access, 256 MB memory limit.`,
        toolset: 'code',
        maxResultChars: 10_000,
        outputIsUntrusted: true,
        capabilities: {
            process: { allowedBinaries: ['docker'] },
        },
        isAvailable() {
            return sandbox.isAvailable();
        },
        schema: {
            type: 'object',
            properties: {
                runtime: {
                    type: 'string',
                    enum: Object.keys(RUNTIMES),
                    description: `Execution runtime: ${RUNTIME_NAMES}`,
                },
                code: {
                    type: 'string',
                    description: 'Code to execute',
                },
                timeout_ms: {
                    type: 'number',
                    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
                },
            },
            required: ['runtime', 'code'],
        },
        async execute(args) {
            const { runtime, code, timeout_ms } = args;
            if (!runtime)
                return { ok: false, error: 'runtime is required', code: 'input_invalid' };
            if (!code)
                return { ok: false, error: 'code is required', code: 'input_invalid' };
            if (!(runtime in RUNTIMES)) {
                return {
                    ok: false,
                    error: `Unknown runtime '${runtime}'. Supported: ${RUNTIME_NAMES}`,
                    code: 'input_invalid',
                };
            }
            if (!sandbox.isAvailable()) {
                return { ok: false, error: 'Docker is not available', code: 'not_available' };
            }
            const { image, cmd } = RUNTIMES[runtime];
            const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
            const result = await sandbox.run(image, [...cmd], { stdin: code, timeoutMs: timeout });
            const output = stripAnsiEscapes([result.stdout, result.stderr].filter(Boolean).join('\n').trim());
            if (result.exitCode !== 0) {
                return {
                    ok: false,
                    error: `Exited with code ${result.exitCode}:\n${output || '(no output)'}`,
                    code: 'execution_failed',
                };
            }
            return { ok: true, value: output || '(no output)' };
        },
    };
}
// ---------------------------------------------------------------------------
// run_tests — runs the test suite locally (no Docker)
// ---------------------------------------------------------------------------
const runTestsTool = {
    name: 'run_tests',
    description: 'Run the project test suite. Defaults to "pnpm test" (vitest). Override with the command arg.',
    toolset: 'code',
    maxResultChars: 20_000,
    outputIsUntrusted: true,
    capabilities: {
        process: { allowedBinaries: ['bash'] },
    },
    schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Test command to run (default: "pnpm test")',
            },
            cwd: {
                type: 'string',
                description: 'Working directory for the command',
            },
        },
    },
    async execute(args, ctx) {
        const { command = 'pnpm test', cwd } = args;
        if (!ctx.scopedProcess) {
            return {
                ok: false,
                error: 'Process capability not configured',
                code: 'not_available',
            };
        }
        const workDir = cwd ?? ctx.workingDir;
        try {
            const { exitCode, stdout, stderr } = await ctx.scopedProcess.spawn('bash', ['-c', command], {
                cwd: workDir,
                timeout: 120_000,
            });
            const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
            if (exitCode !== 0) {
                return {
                    ok: false,
                    error: `Tests failed (code ${exitCode}):\n${out || '(no output)'}`,
                    code: 'execution_failed',
                };
            }
            return { ok: true, value: out || '(tests passed with no output)' };
        }
        catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: 'execution_failed',
            };
        }
    },
};
// ---------------------------------------------------------------------------
// lint — runs the linter locally (no Docker)
// ---------------------------------------------------------------------------
const lintTool = {
    name: 'lint',
    description: 'Run the project linter. Defaults to "pnpm lint" (Biome). Override with the command arg.',
    toolset: 'code',
    maxResultChars: 10_000,
    outputIsUntrusted: true,
    capabilities: {
        process: { allowedBinaries: ['bash'] },
    },
    schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Lint command to run (default: "pnpm lint")',
            },
            cwd: {
                type: 'string',
                description: 'Working directory for the command',
            },
        },
    },
    async execute(args, ctx) {
        const { command = 'pnpm lint', cwd } = args;
        if (!ctx.scopedProcess) {
            return {
                ok: false,
                error: 'Process capability not configured',
                code: 'not_available',
            };
        }
        const workDir = cwd ?? ctx.workingDir;
        try {
            const { exitCode, stdout, stderr } = await ctx.scopedProcess.spawn('bash', ['-c', command], {
                cwd: workDir,
                timeout: 60_000,
            });
            const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
            if (exitCode !== 0) {
                return {
                    ok: false,
                    error: `Lint failed:\n${out || '(no output)'}`,
                    code: 'execution_failed',
                };
            }
            return { ok: true, value: out || '(no lint issues)' };
        }
        catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: 'execution_failed',
            };
        }
    },
};
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createCodeTools(sandbox) {
    return [createRunCodeTool(sandbox), runTestsTool, lintTool];
}
