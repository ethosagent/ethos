import { Box, Text } from 'ink';

export type SafetyTag = 'READ_ONLY' | 'SUGGESTED' | 'APPROVAL_REQUIRED' | 'DESTRUCTIVE';

interface SafetyLaneProps {
  readonlyMode: boolean;
  tags: SafetyTag[];
  focused?: boolean;
}

function colorFor(tag: SafetyTag): string {
  switch (tag) {
    case 'DESTRUCTIVE':
      return 'red';
    case 'APPROVAL_REQUIRED':
      return 'yellow';
    case 'SUGGESTED':
      return 'cyan';
    default:
      return 'green';
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

  return (
    <Box
      borderStyle="single"
      borderColor={focused ? 'cyan' : undefined}
      paddingX={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold>safety</Text>
      <Text color={readonlyMode ? 'green' : 'yellow'}>
        mode: {readonlyMode ? 'READ-ONLY' : 'EXECUTION'}
      </Text>
      {(['READ_ONLY', 'SUGGESTED', 'APPROVAL_REQUIRED', 'DESTRUCTIVE'] as const).map((tag) => (
        <Text key={tag} color={colorFor(tag)}>
          {tag}: {counts.get(tag) ?? 0}
        </Text>
      ))}
      <Text dimColor>/readonly toggles execution lock</Text>
    </Box>
  );
}
