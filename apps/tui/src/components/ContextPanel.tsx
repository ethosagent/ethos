import { Box, Text } from 'ink';
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
  const activeNames = activeTools.slice(-3).map((t) => t.toolName);

  return (
    <Box
      borderStyle="single"
      borderColor={focused ? 'cyan' : undefined}
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold>context</Text>
      <Text dimColor>messages: {messageCount}</Text>
      <Text dimColor>queue: {queueDepth}</Text>
      <Text dimColor>active tools: {activeTools.length}</Text>
      {activeNames.length > 0 ? (
        <Text dimColor>now: {activeNames.join(', ')}</Text>
      ) : (
        <Text dimColor>now: none</Text>
      )}
      <Text dimColor>completed tools: {completedTools.length}</Text>
      <Text dimColor>pending approvals: {pendingPatchCount}</Text>
    </Box>
  );
}
