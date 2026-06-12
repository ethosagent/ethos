import { Box, Text } from 'ink';
import { useSkin } from '../skin';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  accentColor?: string;
}

interface ChatRowProps {
  message: ChatMessage;
  accentColor?: string;
}

// A single chat row. Used inside Ink's <Static> in App.tsx so settled
// messages print once to terminal scrollback and never re-render — that's
// what prevents the dynamic Ink frame from growing past the terminal
// viewport height (which previously caused the chrome to print twice on
// every turn).
export function ChatRow({ message, accentColor }: ChatRowProps) {
  const tokens = useSkin();
  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.role === 'system' ? (
        <Box gap={1}>
          <Text dimColor>{tokens.glyphs.accentStripe}</Text>
          <Text dimColor wrap="wrap">
            {message.text}
          </Text>
        </Box>
      ) : message.role === 'user' ? (
        <Box gap={1}>
          <Text color={tokens.semantic.info} bold>
            You
          </Text>
          <Text dimColor>{tokens.glyphs.prompt}</Text>
          <Text wrap="wrap">{message.text}</Text>
        </Box>
      ) : (
        <Box gap={1}>
          <Text color={message.accentColor ?? accentColor ?? tokens.semantic.success}>
            {tokens.glyphs.accentStripe}
          </Text>
          <Text bold color={tokens.surface.textPrimary}>
            ethos
          </Text>
          <Text dimColor>{tokens.glyphs.prompt}</Text>
          <Text wrap="wrap">{message.text}</Text>
        </Box>
      )}
    </Box>
  );
}

interface StreamingRowProps {
  text: string;
  accentColor?: string;
}

// The in-flight assistant message. Renders inside the dynamic frame —
// re-renders on every text_delta as the model streams. On `done`, App.tsx
// flushes this text into the committed-messages list (which prints via
// <Static>) and clears it.
export function StreamingRow({ text, accentColor }: StreamingRowProps) {
  const tokens = useSkin();
  if (!text) return null;
  return (
    <Box marginBottom={1} gap={1}>
      <Text color={accentColor ?? tokens.semantic.success}>{tokens.glyphs.accentStripe}</Text>
      <Text bold color={tokens.surface.textPrimary}>
        ethos
      </Text>
      <Text dimColor>{tokens.glyphs.prompt}</Text>
      <Text wrap="wrap">{text}</Text>
    </Box>
  );
}
