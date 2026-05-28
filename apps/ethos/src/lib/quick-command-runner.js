// FW-16 — run user-defined shell commands and format their output.
import { spawnSync } from 'node:child_process';
export function runQuickCommand(command, timeoutMs = 30_000) {
  // spawnSync via shell — captures both stdout and stderr regardless of exit code.
  const result = spawnSync('sh', ['-c', command], {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = (result.stdout ?? '').toString();
  const stderr = (result.stderr ?? '').toString();
  // spawnSync sets status=null on timeout/signal; treat as non-zero.
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return { stdout, stderr, exitCode };
}
export function formatQuickCommandOutput(result) {
  const parts = [];
  if (result.stdout) {
    parts.push(`\`\`\`\n${result.stdout.trimEnd()}\n\`\`\``);
  }
  if (result.stderr) {
    parts.push(`[stderr]\n\`\`\`\n${result.stderr.trimEnd()}\n\`\`\``);
  }
  if (result.exitCode !== 0) {
    parts.push(`[exit code: ${result.exitCode}]`);
  }
  return parts.join('\n') || '(no output)';
}
