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
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  for await (const chunk of stream) {
    if (chunk.stream === 'exit') exitCode = chunk.code;
    else if (chunk.stream === 'stdout') stdout += chunk.data;
    else stderr += chunk.data;
  }
  return { stdout, stderr, exitCode };
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
    async execute(args, ctx): Promise<ToolResult> {
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
        const { stdout, stderr, exitCode } = await drainExec(
          backend.exec(cmd, {
            stdin: code,
            timeoutMs: timeout,
            env: {},
            personality,
            sessionId: ctx.sessionId,
          }),
        );
        const output = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
        // A non-zero interpreter exit means the code failed (syntax/runtime
        // error). A null exit code (older backend) preserves prior success.
        if (exitCode !== null && exitCode !== 0) {
          return {
            ok: false,
            error: `Code exited with error (code ${exitCode}):\n${output || '(no output)'}`,
            code: 'execution_failed',
          };
        }
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
// Shared command runner for run_tests / lint
//
// Both route through the SAME resolved execution posture as run_code and
// terminal (security fix F1):
//   - backend present (docker posture) → run mount-confined inside the container;
//   - no backend + host allowed (local/none posture) → host ScopedProcess;
//   - no backend + host forbidden (docker posture, no backend, constitution
//     forbids local) → `not_available`, NEVER silently run on the host.
// ---------------------------------------------------------------------------

interface CommandToolOpts {
  name: string;
  description: string;
  maxResultChars: number;
  defaultCommand: string;
  timeoutMs: number;
  failurePrefix: (exitCode: number) => string;
  emptySuccess: string;
}

function makeCommandTool(
  opts: CommandToolOpts,
  backend: ExecutionBackend | undefined,
  personality: PersonalityConfig | undefined,
  hostExecForbidden: boolean,
): Tool {
  return {
    name: opts.name,
    description: opts.description,
    toolset: 'code',
    maxResultChars: opts.maxResultChars,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: backend ? ['docker'] : ['bash'] },
    },
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `Command to run (default: "${opts.defaultCommand}")`,
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command = opts.defaultCommand, cwd } = args as { command?: string; cwd?: string };
      const workDir = cwd ?? ctx.workingDir;

      // Routed path (docker posture): run inside the mount-confined backend.
      // env is empty so host secrets never cross into the container (review #3).
      if (backend) {
        try {
          const { stdout, stderr, exitCode } = await drainExec(
            backend.exec(command, {
              cwd: workDir,
              timeoutMs: opts.timeoutMs,
              env: {},
              personality,
              sessionId: ctx.sessionId,
            }),
          );
          const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
          if (exitCode !== null && exitCode !== 0) {
            return {
              ok: false,
              error: `${opts.failurePrefix(exitCode)}\n${out || '(no output)'}`,
              code: 'execution_failed',
            };
          }
          return { ok: true, value: out || opts.emptySuccess };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'execution_failed',
          };
        }
      }

      // Host execution forbidden: posture requires Docker but none is available
      // and the constitution forbids the host fallback. Refuse (F1).
      if (hostExecForbidden) {
        return {
          ok: false,
          error:
            'Execution requires a Docker sandbox, but none is available and the constitution forbids running un-sandboxed on the host.',
          code: 'not_available' as const,
        };
      }

      // Local path (posture local/none): host ScopedProcess execution.
      if (!ctx.scopedProcess) {
        return {
          ok: false,
          error: 'Process capability not configured',
          code: 'not_available' as const,
        };
      }

      try {
        const { exitCode, stdout, stderr } = await ctx.scopedProcess.spawn(
          'bash',
          ['-c', command],
          {
            cwd: workDir,
            timeout: opts.timeoutMs,
          },
        );
        const out = stripAnsiEscapes([stdout, stderr].filter(Boolean).join('\n').trim());
        if (exitCode !== 0) {
          return {
            ok: false,
            error: `${opts.failurePrefix(exitCode)}\n${out || '(no output)'}`,
            code: 'execution_failed',
          };
        }
        return { ok: true, value: out || opts.emptySuccess };
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

function createRunTestsTool(
  backend: ExecutionBackend | undefined,
  personality: PersonalityConfig | undefined,
  hostExecForbidden: boolean,
): Tool {
  return makeCommandTool(
    {
      name: 'run_tests',
      description:
        'Run the project test suite. Defaults to "pnpm test" (vitest). Override with the command arg.',
      maxResultChars: 20_000,
      defaultCommand: 'pnpm test',
      timeoutMs: 120_000,
      failurePrefix: (code) => `Tests failed (code ${code}):`,
      emptySuccess: '(tests passed with no output)',
    },
    backend,
    personality,
    hostExecForbidden,
  );
}

function createLintTool(
  backend: ExecutionBackend | undefined,
  personality: PersonalityConfig | undefined,
  hostExecForbidden: boolean,
): Tool {
  return makeCommandTool(
    {
      name: 'lint',
      description:
        'Run the project linter. Defaults to "pnpm lint" (Biome). Override with the command arg.',
      maxResultChars: 10_000,
      defaultCommand: 'pnpm lint',
      timeoutMs: 60_000,
      failurePrefix: () => 'Lint failed:',
      emptySuccess: '(no lint issues)',
    },
    backend,
    personality,
    hostExecForbidden,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodeTools(opts?: {
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
  /** Refuse host execution when the posture requires Docker but none is wired. */
  hostExecForbidden?: boolean;
}): Tool[] {
  const hostExecForbidden = opts?.hostExecForbidden ?? false;
  return [
    createRunCodeTool(opts?.backend, opts?.personality),
    createRunTestsTool(opts?.backend, opts?.personality, hostExecForbidden),
    createLintTool(opts?.backend, opts?.personality, hostExecForbidden),
  ];
}
