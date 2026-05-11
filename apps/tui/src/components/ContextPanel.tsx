import { Box, Text } from 'ink';
import { useSkin } from '../skin';
import type { ActiveTool, CompletedTool } from './ToolSpinner';

interface ContextPanelProps {
  activeTools: ActiveTool[];
  completedTools: CompletedTool[];
  queueDepth: number;
  messageCount: number;
  pendingPatchCount: number;
  focused?: boolean;
}

export function ContextPanel({
  activeTools,
  completedTools,
  queueDepth,
  messageCount,
  pendingPatchCount,
  focused = false,
}: ContextPanelProps) {
  const tokens = useSkin();
  const activeNames = activeTools.slice(-3).map((t) => t.toolName);

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text dimColor color={focused ? tokens.semantic.info : undefined}>
        {'─── '}
        <Text bold color={focused ? tokens.semantic.info : tokens.surface.textPrimary}>
          context
        </Text>
        {' ───'}
      </Text>
      <Text dimColor>
        messages: {messageCount} · queue: {queueDepth} · active: {activeTools.length} · completed:{' '}
        {completedTools.length}
        {pendingPatchCount > 0 ? ` · pending: ${pendingPatchCount}` : ''}
      </Text>
      {activeNames.length > 0 && <Text dimColor>now: {activeNames.join(', ')}</Text>}
    </Box>
  );
}
