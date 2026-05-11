import { Box, Text } from 'ink';
import { useSkin } from '../skin';

interface ThinkingPaneProps {
  text: string;
}

export function ThinkingPane({ text }: ThinkingPaneProps) {
  const tokens = useSkin();
  if (!text) return null;
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable static split
        <Text key={i} color={tokens.accents.coach} dimColor wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}
