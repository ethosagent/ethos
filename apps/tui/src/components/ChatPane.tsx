import { Box, Text } from 'ink';
import { DESIGN, GLYPHS } from '../skin';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  accentColor?: string;
}

interface ChatPaneProps {
  messages: ChatMessage[];
  streamingText: string;
  accentColor?: string;
}

// Show only the last N messages to keep the render height bounded.
const MAX_VISIBLE = 12;

export function ChatPane({ messages, streamingText, accentColor }: ChatPaneProps) {
  const visible = messages.slice(-MAX_VISIBLE);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          {msg.role === 'user' ? (
            <Box gap={1}>
              <Text color={DESIGN.info} bold>
                You
              </Text>
              <Text dimColor>{GLYPHS.prompt}</Text>
              <Text wrap="wrap">{msg.text}</Text>
            </Box>
          ) : (
            <Box gap={1}>
              <Text color={msg.accentColor ?? accentColor ?? DESIGN.success}>
                {GLYPHS.accentStripe}
              </Text>
              <Text bold color={DESIGN.textPrimary}>
                ethos
              </Text>
              <Text dimColor>{GLYPHS.prompt}</Text>
              <Text wrap="wrap">{msg.text}</Text>
            </Box>
          )}
        </Box>
      ))}
      {streamingText && (
        <Box gap={1}>
          <Text color={accentColor ?? DESIGN.success}>{GLYPHS.accentStripe}</Text>
          <Text bold color={DESIGN.textPrimary}>
            ethos
          </Text>
          <Text dimColor>{GLYPHS.prompt}</Text>
          <Text wrap="wrap">{streamingText}</Text>
        </Box>
      )}
    </Box>
  );
}
