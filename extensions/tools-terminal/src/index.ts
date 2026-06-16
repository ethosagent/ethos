import type {
  ExecChunk,
  ExecutionBackend,
  PersonalityConfig,
  Tool,
  ToolResult,
} from '@ethosagent/types';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Drain an `ExecChunk` stream into combined stdout/stderr strings, mirroring
 * the ScopedProcess result shape so the routed and local paths produce the
 * same ToolResult. Throws on backend stream errors (timeout/abort/unavailable),
 * which the caller maps to `execution_failed`.
 */
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
// terminal
// ---------------------------------------------------------------------------

/**
 * Build the terminal tool. When `backend` is injected (posture ≠ local/none)
 * the command runs through the backend's mount-confined `exec`; otherwise the
 * existing ScopedProcess host path is used unchanged.
 */
function makeTerminalTool(
  backend: ExecutionBackend | undefined,
  personality: PersonalityConfig | undefined,
): Tool {
  return {
    name: 'terminal',
    description:
      'Run a shell command and return its output. Commands run in the working directory by default. Use for build commands, tests, git operations, file operations, and anything that needs a shell. Avoid interactive commands that require user input.',
    toolset: 'terminal',
    maxResultChars: 20_000,
    outputIsUntrusted: true,
    capabilities: {
      process: { allowedBinaries: ['*'] },
    },
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (defaults to agent working directory)',
        },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { command, cwd, timeout_ms } = args as {
        command: string;
        cwd?: string;
        timeout_ms?: number;
      };

      if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };

      const workDir = cwd ?? ctx.workingDir;
      const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      // Routed path: run inside the mount-confined backend. env is empty by
      // default (review #3) so host secrets never cross into the container.
      if (backend) {
        try {
          const { stdout, stderr } = await drainExec(
            backend.exec(command, {
              cwd: workDir,
              timeoutMs: timeout,
              env: {},
              personality,
              sessionId: ctx.sessionId,
            }),
          );
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          return { ok: true, value: out || '(command completed with no output)' };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: 'execution_failed',
          };
        }
      }

      // Local path (posture local/none): unchanged ScopedProcess execution.
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
            timeout,
          },
        );

        const out = [stdout, stderr].filter(Boolean).join('\n').trim();

        if (exitCode !== 0) {
          return {
            ok: false,
            error: `Command exited with error (code ${exitCode}):\n${out || '(no output)'}`,
            code: 'execution_failed',
          };
        }

        return {
          ok: true,
          value: out || '(command completed with no output)',
        };
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

/** Local-posture terminal tool (no backend). Exported for tests. */
export const terminalTool: Tool = makeTerminalTool(undefined, undefined);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTerminalTools(opts?: {
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
}): Tool[] {
  return [makeTerminalTool(opts?.backend, opts?.personality)];
}

export { checkCommand, createTerminalGuardHook } from './guard';
