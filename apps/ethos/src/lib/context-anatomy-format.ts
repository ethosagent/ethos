import type { ContextAnatomy } from '@ethosagent/observability-sqlite';

interface Style {
  bold: (s: string) => string;
  dim: (s: string) => string;
}

/**
 * The one text rendering of a session's context anatomy, shared by
 * `ethos sessions show` and the chat REPL's `/compact status`. Pure: the
 * caller owns colour and output.
 */
export function formatContextAnatomy(a: ContextAnatomy, style: Style): string {
  const { bold, dim } = style;
  const n = (v: number): string => v.toLocaleString();
  const win = a.contextWindow;
  const pct = (v: number): string => (win ? `  ${dim(`${Math.round((v / win) * 100)}%`)}` : '');
  const row = (label: string, v: number): string =>
    `  ${label.padEnd(12)}${n(v).padStart(9)} tok${pct(v)}\n`;
  const calls = `latest of ${a.llmCallCount} llm call${a.llmCallCount === 1 ? '' : 's'}`;
  const totalNote = win
    ? `  ${dim(`${Math.round((a.total / win) * 100)}% of ${n(win)}`)}`
    : `  ${dim('window unknown')}`;

  return (
    `${bold('Context anatomy')} ${dim(`(${calls})`)}\n` +
    row('system', Math.max(0, a.system - a.memory - a.skills)) +
    row('memory ≈', a.memory) +
    row('skills ≈', a.skills) +
    row('tools', a.tools) +
    row('messages', a.messages) +
    `  ${dim('─────────────')}\n` +
    `  ${'total'.padEnd(12)}${n(a.total).padStart(9)} tok${totalNote}\n` +
    (a.compactAtTokens !== null
      ? `  ${'compacts at'.padEnd(12)}${n(a.compactAtTokens).padStart(9)} tok\n`
      : '') +
    `  ${'cache hit'.padEnd(12)}${`${Math.round(a.cacheHitRate * 100)}%`.padStart(9)}\n` +
    `  ${dim('≈ memory/skills split by size share')}\n`
  );
}
