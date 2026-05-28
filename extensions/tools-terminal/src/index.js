const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000; // 5 minutes
// ---------------------------------------------------------------------------
// terminal
// ---------------------------------------------------------------------------
export const terminalTool = {
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
  async execute(args, ctx) {
    const { command, cwd, timeout_ms } = args;
    if (!command) return { ok: false, error: 'command is required', code: 'input_invalid' };
    if (!ctx.scopedProcess) {
      return {
        ok: false,
        error: 'Process capability not configured',
        code: 'not_available',
      };
    }
    const workDir = cwd ?? ctx.workingDir;
    const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    try {
      const { exitCode, stdout, stderr } = await ctx.scopedProcess.spawn('bash', ['-c', command], {
        cwd: workDir,
        timeout,
      });
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
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createTerminalTools() {
  return [terminalTool];
}
export { checkCommand, createTerminalGuardHook } from './guard';
