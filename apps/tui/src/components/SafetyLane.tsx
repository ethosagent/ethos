import { Box, Text } from 'ink';
import { DESIGN } from '../skin';

export type SafetyTag = 'READ_ONLY' | 'SUGGESTED' | 'APPROVAL_REQUIRED' | 'DESTRUCTIVE';

interface SafetyLaneProps {
  readonlyMode: boolean;
  tags: SafetyTag[];
  focused?: boolean;
}

function colorFor(tag: SafetyTag): string {
  switch (tag) {
    case 'DESTRUCTIVE':
      return DESIGN.error;
    case 'APPROVAL_REQUIRED':
      return DESIGN.warning;
    case 'SUGGESTED':
      return DESIGN.info;
    default:
      return DESIGN.success;
  }
}

export function SafetyLane({ readonlyMode, tags, focused = false }: SafetyLaneProps) {
  const counts = new Map<SafetyTag, number>([
    ['READ_ONLY', 0],
    ['SUGGESTED', 0],
    ['APPROVAL_REQUIRED', 0],
    ['DESTRUCTIVE', 0],
  ]);
  for (const tag of tags) {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  const activeTags = (
    ['READ_ONLY', 'SUGGESTED', 'APPROVAL_REQUIRED', 'DESTRUCTIVE'] as const
  ).filter((tag) => (counts.get(tag) ?? 0) > 0);

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text dimColor color={focused ? DESIGN.info : undefined}>
        {'─── '}
        <Text bold color={focused ? DESIGN.info : DESIGN.textPrimary}>
          safety
        </Text>
        {' ───'}
      </Text>
      <Box gap={2}>
        <Text color={readonlyMode ? DESIGN.success : DESIGN.textSecondary}>
          {readonlyMode ? 'READ-ONLY' : 'execution'}
        </Text>
        {activeTags.map((tag) => (
          <Text key={tag} color={colorFor(tag)}>
            {tag.toLowerCase().replace(/_/g, '-')}: {counts.get(tag) ?? 0}
          </Text>
        ))}
        {activeTags.length === 0 && <Text dimColor>no active flags</Text>}
      </Box>
      <Text dimColor>/readonly toggles execution lock</Text>
    </Box>
  );
}
