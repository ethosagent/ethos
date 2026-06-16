import { stripAnsiEscapes } from '@ethosagent/core';
import type {
  ExecChunk,
  ExecutionBackend,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Runtime definitions
// ---------------------------------------------------------------------------

/**
 * The per-runtime interpreter command. The code is piped to the interpreter on
 * stdin via the backend `exec` (mount/network/memory policy is owned by the
 * backend; runtime images are digest-pinned in `config.images` per Lane A #2).
 */
const RUNTIMES = {
  python: { cmd: 'python3 -' },
  js: { cmd: 'node --input-type=module' },
  bash: { cmd: 'bash -s' },
} as const;

type Runtime = keyof typeof RUNTIMES;

const RUNTIME_NAMES = Object.keys(RUNTIMES).join(', ');

async function drainExec(
  stream: AsyncIterable<ExecChunk>,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  for await (const chunk of stream) {
    if (chunk.stream === 'stdout') stdout += chunk.data;
    else stderr += chunk.data;
  }
  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

function createRunCodeTool(
  backend: ExecutionBackend | undefined,
  personality: PersonalityConfig | undefined,
): Tool {
  return {
    name: 'run_code',
    description: `Run code in an isolated container. Supported runtimes: ${RUNTIME_NAMES}. No network access, memory-capped.`,
    toolset: 'code',
    maxResultChars: 10_000,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: ['docker'] },
    },
    // Sync gate per the Tool contract: report available when a backend is
    // wired. The async daemon liveness check happens in execute(), which
    // returns `not_available` if the backend is actually down.
    isAvailable() {
      return backend !== undefined;
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
    async execute(args): Promise<ToolResult> {
      const { runtime, code, timeout_ms } = args as {
        runtime: string;
        code: string;
        timeout_ms?: number;
      };

      if (!runtime) return { ok: false, error: 'runtime is required', code: 'input_invalid' };
      if (!code) return { ok: false, error: 'code is required', code: 'input_invalid' };
      if (!(runtime in RUNTIMES)) {
        return {
          ok: false,
          error: `Unknown runtime '${runtime}'. Supported: ${RUNTIME_NAMES}`,
          code: 'input_invalid',
        };
      }
      // No host fallback: if the backend is absent or unavailable, run_code is
      // simply not available (it never executes on the host).
      if (!backend || !(await backend.isAvailable())) {
        return {
          ok: false,
          error: 'Code execution backend is not available',
          code: 'not_available',
        };
      }

      const { cmd } = RUNTIMES[runtime as Runtime];
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;

      try {
        const { stdout, stderr } = await drainExec(
          backend.exec(cmd, {
            stdin: code,
            timeoutMs: timeout,
            env: {},
            personality,
          }),
        );
        const output = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
        return { ok: true, value: output || '(no output)' };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// run_tests — runs the test suite locally (no Docker)
// ---------------------------------------------------------------------------

const runTestsTool: Tool = {
  name: 'run_tests',
  description:
    'Run the project test suite. Defaults to "pnpm test" (vitest). Override with the command arg.',
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
  async execute(args, ctx): Promise<ToolResult> {
    const { command = 'pnpm test', cwd } = args as { command?: string; cwd?: string };

    if (!ctx.scopedProcess) {
      return {
        ok: false,
        error: 'Process capability not configured',
        code: 'not_available' as const,
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
    } catch (err) {
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

const lintTool: Tool = {
  name: 'lint',
  description:
    'Run the project linter. Defaults to "pnpm lint" (Biome). Override with the command arg.',
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
  async execute(args, ctx): Promise<ToolResult> {
    const { command = 'pnpm lint', cwd } = args as { command?: string; cwd?: string };

    if (!ctx.scopedProcess) {
      return {
        ok: false,
        error: 'Process capability not configured',
        code: 'not_available' as const,
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
    } catch (err) {
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

export function createCodeTools(opts?: {
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
}): Tool[] {
  return [createRunCodeTool(opts?.backend, opts?.personality), runTestsTool, lintTool];
}
