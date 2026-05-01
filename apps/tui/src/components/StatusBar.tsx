import { Box, Text } from 'ink';
import { DESIGN } from '../skin';

export type AgentStatus = 'idle' | 'thinking' | 'running' | 'interrupted';

export interface UpdateStatus {
  behind: number;
  latest: string;
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
  switch (status) {
    case 'thinking':
      return (
        <Text color={DESIGN.warning}>
          {' thinking '}
          {elapsedSecs !== undefined && elapsedSecs > 0 ? padTime(elapsedSecs) : '…    '}
        </Text>
      );
    case 'running':
      return (
        <Text color={DESIGN.info}>
          {' running'}
          {currentTool ? `: ${currentTool}` : ''}
          {'…'}
        </Text>
      );
    case 'interrupted':
      return <Text color={DESIGN.error}> interrupted</Text>;
    default:
      return null;
  }
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
}: StatusBarProps) {
  return (
    <Box marginBottom={1}>
      <Text bold color={DESIGN.textPrimary}>
        ethos
      </Text>
      <Text color={DESIGN.textSecondary}> {model} ·</Text>
      <Text color={accentColor}>{` ${personality}`}</Text>
      {readonlyMode && <Text color={DESIGN.success}> [READ-ONLY]</Text>}
      <StatusIndicator status={status} currentTool={currentTool} elapsedSecs={elapsedSecs} />
      <Text color={DESIGN.textSecondary}>
        {'  '}
        {inputTokens.toLocaleString()} in · {outputTokens.toLocaleString()} out $
        {costUsd.toFixed(5)}
      </Text>
      {backgroundCount > 0 && <Text color={DESIGN.warning}>{` bg:${backgroundCount}`}</Text>}
      {updateStatus && updateStatus.behind > 0 && (
        <Text color={DESIGN.warning}>
          {` ! ${updateStatus.behind} version${updateStatus.behind === 1 ? '' : 's'} behind — pnpm dlx ethos upgrade`}
        </Text>
      )}
    </Box>
  );
}
