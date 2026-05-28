import { Box, Text } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { useSkin } from '../skin';

function padTime(secs) {
  const s = `${secs}s`;
  return s.padEnd(5);
}
function StatusIndicator({ status, currentTool, elapsedSecs }) {
  const tokens = useSkin();
  switch (status) {
    case 'thinking':
      return _jsxs(Text, {
        color: tokens.semantic.warning,
        children: [
          ' thinking ',
          elapsedSecs !== undefined && elapsedSecs > 0 ? padTime(elapsedSecs) : '…    ',
        ],
      });
    case 'running':
      return _jsxs(Text, {
        color: tokens.semantic.info,
        children: [' running', currentTool ? `: ${currentTool}` : '', '…'],
      });
    case 'interrupted':
      return _jsx(Text, { color: tokens.semantic.error, children: ' interrupted' });
    default:
      return null;
  }
}
function BudgetIndicator({ budgetState }) {
  const tokens = useSkin();
  const ratio = budgetState.cap > 0 ? budgetState.spent / budgetState.cap : 0;
  const color =
    ratio >= 1
      ? tokens.semantic.error
      : ratio >= 0.8
        ? tokens.semantic.warning
        : tokens.surface.textSecondary;
  return _jsx(Text, {
    color: color,
    children: ` budget $${budgetState.spent.toFixed(4)}/$${budgetState.cap.toFixed(2)}`,
  });
}
export function StatusBar({
  model,
  personality,
  accentColor,
  inputTokens,
  outputTokens,
  costUsd,
  status,
  currentTool,
  elapsedSecs,
  readonlyMode = false,
  backgroundCount = 0,
  updateStatus,
  budgetState,
}) {
  const tokens = useSkin();
  return _jsxs(Box, {
    marginBottom: 1,
    children: [
      _jsx(Text, { bold: true, color: tokens.surface.textPrimary, children: 'ethos' }),
      _jsxs(Text, { color: tokens.surface.textSecondary, children: [' ', model, ' \u00B7'] }),
      _jsx(Text, { color: accentColor, children: ` ${personality}` }),
      readonlyMode && _jsx(Text, { color: tokens.semantic.success, children: ' [READ-ONLY]' }),
      _jsx(StatusIndicator, { status: status, currentTool: currentTool, elapsedSecs: elapsedSecs }),
      _jsxs(Text, {
        color: tokens.surface.textSecondary,
        children: [
          '  ',
          inputTokens.toLocaleString(),
          ' in \u00B7 ',
          outputTokens.toLocaleString(),
          ' out $',
          costUsd.toFixed(5),
        ],
      }),
      budgetState && _jsx(BudgetIndicator, { budgetState: budgetState }),
      backgroundCount > 0 &&
        _jsx(Text, { color: tokens.semantic.warning, children: ` bg:${backgroundCount}` }),
      updateStatus &&
        updateStatus.behind > 0 &&
        _jsx(Text, {
          color: tokens.semantic.warning,
          children: ` ! ${updateStatus.behind} version${updateStatus.behind === 1 ? '' : 's'} behind — pnpm dlx ethos upgrade`,
        }),
    ],
  });
}
