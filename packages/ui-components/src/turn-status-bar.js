import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
export function TurnStatusBar({ isStreaming, currentOp, elapsedMs }) {
  if (!isStreaming && !currentOp) return null;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedDisplay = elapsedSec > 0 ? `  ${elapsedSec}s` : '';
  return _jsxs('div', {
    style: {
      padding: '4px 16px',
      fontSize: 12,
      color: 'var(--text-tertiary, #888)',
      fontFamily: 'var(--font-display, system-ui)',
      opacity: isStreaming || currentOp ? 1 : 0,
      transition: 'opacity 2s ease-out',
    },
    children: [
      _jsx('span', { children: currentOp ?? 'Thinking…' }),
      _jsx('span', { children: elapsedDisplay }),
    ],
  });
}
