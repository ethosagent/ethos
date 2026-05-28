export interface TurnStatusBarProps {
  isStreaming: boolean;
  currentOp: string | null;
  elapsedMs: number;
}

export function TurnStatusBar({ isStreaming, currentOp, elapsedMs }: TurnStatusBarProps) {
  if (!isStreaming && !currentOp) return null;

  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedDisplay = elapsedSec > 0 ? `  ${elapsedSec}s` : '';

  return (
    <div
      style={{
        padding: '4px 16px',
        fontSize: 12,
        color: 'var(--text-tertiary, #888)',
        fontFamily: 'var(--font-display, system-ui)',
        opacity: isStreaming || currentOp ? 1 : 0,
        transition: 'opacity 2s ease-out',
      }}
    >
      <span>{currentOp ?? 'Thinking…'}</span>
      <span>{elapsedDisplay}</span>
    </div>
  );
}
