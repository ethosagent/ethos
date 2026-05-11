import { Box, Text } from 'ink';
import { useSkin } from '../skin';

export type SafetyTag = 'READ_ONLY' | 'SUGGESTED' | 'APPROVAL_REQUIRED' | 'DESTRUCTIVE';

interface SafetyLaneProps {
  readonlyMode: boolean;
  tags: SafetyTag[];
  focused?: boolean;
}

export function SafetyLane({ readonlyMode, tags, focused = false }: SafetyLaneProps) {
  const tokens = useSkin();
  const colorFor = (tag: SafetyTag): string => {
    switch (tag) {
      case 'DESTRUCTIVE':
        return tokens.semantic.error;
      case 'APPROVAL_REQUIRED':
        return tokens.semantic.warning;
      case 'SUGGESTED':
        return tokens.semantic.info;
      default:
        return tokens.semantic.success;
    }
  };

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
      <Text dimColor color={focused ? tokens.semantic.info : undefined}>
        {'─── '}
        <Text bold color={focused ? tokens.semantic.info : tokens.surface.textPrimary}>
          safety
        </Text>
        {' ───'}
      </Text>
      <Box gap={2}>
        <Text color={readonlyMode ? tokens.semantic.success : tokens.surface.textSecondary}>
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
