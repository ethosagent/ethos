import { Box, Text } from 'ink';
import { useSkin } from '../skin';

export type AgentStatus = 'idle' | 'thinking' | 'running' | 'interrupted';

export interface UpdateStatus {
  behind: number;
  latest: string;
}

export interface BudgetState {
  spent: number;
  cap: number;
}

interface StatusBarProps {
  model: string;
  personality: string;
  accentColor?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: AgentStatus;
  currentTool?: string;
  /** Live elapsed seconds — shown only while thinking (always-on timer). */
  elapsedSecs?: number;
  readonlyMode?: boolean;
  backgroundCount?: number;
  updateStatus?: UpdateStatus | null;
  budgetState?: BudgetState | null;
}

function padTime(secs: number): string {
  const s = `${secs}s`;
  return s.padEnd(5);
}

function StatusIndicator({
  status,
  currentTool,
  elapsedSecs,
}: {
  status: AgentStatus;
  currentTool?: string;
  elapsedSecs?: number;
}) {
  const tokens = useSkin();
  switch (status) {
    case 'thinking':
      return (
        <Text color={tokens.semantic.warning}>
          {' thinking '}
          {elapsedSecs !== undefined && elapsedSecs > 0 ? padTime(elapsedSecs) : '…    '}
        </Text>
      );
    case 'running':
      return (
        <Text color={tokens.semantic.info}>
          {' running'}
          {currentTool ? `: ${currentTool}` : ''}
          {'…'}
        </Text>
      );
    case 'interrupted':
      return <Text color={tokens.semantic.error}> interrupted</Text>;
    default:
      return null;
  }
}

function BudgetIndicator({ budgetState }: { budgetState: BudgetState }) {
  const tokens = useSkin();
  const ratio = budgetState.cap > 0 ? budgetState.spent / budgetState.cap : 0;
  const color =
    ratio >= 1
      ? tokens.semantic.error
      : ratio >= 0.8
        ? tokens.semantic.warning
        : tokens.surface.textSecondary;
  return (
    <Text
      color={color}
    >{` budget $${budgetState.spent.toFixed(4)}/$${budgetState.cap.toFixed(2)}`}</Text>
  );
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
}: StatusBarProps) {
  const tokens = useSkin();
  return (
    <Box marginBottom={1}>
      <Text bold color={tokens.surface.textPrimary}>
        ethos
      </Text>
      <Text color={tokens.surface.textSecondary}> {model} ·</Text>
      <Text color={accentColor}>{` ${personality}`}</Text>
      {readonlyMode && <Text color={tokens.semantic.success}> [READ-ONLY]</Text>}
      <StatusIndicator status={status} currentTool={currentTool} elapsedSecs={elapsedSecs} />
      <Text color={tokens.surface.textSecondary}>
        {'  '}
        {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out $
        {costUsd.toFixed(5)}
      </Text>
      {budgetState && <BudgetIndicator budgetState={budgetState} />}
      {backgroundCount > 0 && (
        <Text color={tokens.semantic.warning}>{` bg:${backgroundCount}`}</Text>
      )}
      {updateStatus && updateStatus.behind > 0 && (
        <Text color={tokens.semantic.warning}>
          {` ! ${updateStatus.behind} version${updateStatus.behind === 1 ? '' : 's'} behind — pnpm dlx ethos upgrade`}
        </Text>
      )}
    </Box>
  );
}
