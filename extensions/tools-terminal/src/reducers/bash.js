function extractCommand(args) {
  if (args && typeof args === 'object' && 'command' in args && typeof args.command === 'string') {
    return args.command;
  }
  return '';
}
function isGitStatus(cmd) {
  return /\bgit\s+status\b/.test(cmd);
}
function isTestRun(cmd) {
  return /\b(vitest|pnpm\s+test|pnpm\s+vitest|npm\s+test)\b/.test(cmd);
}
function isInstall(cmd) {
  return /\b(pnpm\s+install|npm\s+install|yarn(\s+install)?)\b/.test(cmd);
}
function reduceGitStatus(result) {
  if (!result.ok) return result;
  const lines = result.value.split('\n');
  const counts = {
    modified: 0,
    staged: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
  };
  const preview = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    if (xy.startsWith('M') || xy.endsWith('M')) {
      counts.modified++;
    } else if (xy.startsWith('A')) {
      counts.staged++;
    } else if (xy.startsWith('D') && xy.endsWith(' ')) {
      counts.deleted++;
    } else if (xy === '??') {
      counts.untracked++;
    } else if (xy.startsWith('R')) {
      counts.renamed++;
    }
    if (preview.length < 5) preview.push(`${xy} ${file}`);
  }
  const parts = [];
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.staged) parts.push(`${counts.staged} staged`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  if (counts.renamed) parts.push(`${counts.renamed} renamed`);
  const summary = parts.length ? parts.join(', ') : 'clean';
  const previewStr = preview.length ? `\nFirst ${preview.length}: ${preview.join(', ')}` : '';
  return {
    ok: true,
    value: `git status: ${summary}.${previewStr}\n(XY codes: M=modified, A=added, D=deleted, R=renamed, ??=untracked)`,
  };
}
function reduceTestRun(result) {
  if (!result.ok) return result;
  const lines = result.value.split('\n');
  const kept = [];
  let inSummary = false;
  for (const line of lines) {
    if (/^\s*(Test Files|Tests|Duration|FAIL|Error:)/.test(line)) {
      inSummary = true;
    }
    if (inSummary || /\b(FAIL|Error:)\b/.test(line)) kept.push(line);
  }
  return { ok: true, value: kept.join('\n') || result.value };
}
function reduceInstall(result) {
  if (!result.ok) return result;
  const lines = result.value.split('\n');
  const kept = lines.filter((l) => /added\s+\d+|removed\s+\d+|warning|error/i.test(l));
  return { ok: true, value: kept.join('\n') || result.value };
}
const HEAD_LINES = 40;
const TAIL_LINES = 20;
const GENERIC_THRESHOLD_BYTES = 8 * 1024;
function reduceGeneric(result) {
  if (!result.ok) return result;
  if (result.value.length <= GENERIC_THRESHOLD_BYTES) return result;
  const lines = result.value.split('\n');
  const totalLines = lines.length;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const marker = `\n... [reduced from ${totalLines} lines / ${result.value.length} bytes to head+tail] ...\n`;
  return { ok: true, value: head.join('\n') + marker + tail.join('\n') };
}
export const bashReducer = {
  toolName: 'terminal',
  reduce(result, ctx) {
    if (!result.ok) return result;
    const cmd = extractCommand(ctx.args);
    if (isGitStatus(cmd)) return reduceGitStatus(result);
    if (isTestRun(cmd)) return reduceTestRun(result);
    if (isInstall(cmd)) return reduceInstall(result);
    return reduceGeneric(result);
  },
};
