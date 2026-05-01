import { basename } from 'node:path';
import { Box, Text } from 'ink';

interface ConsoleHeaderProps {
  model: string;
  personality: string;
  sessionKey: string;
  accentColor: string;
}

export function ConsoleHeader({ model, personality, sessionKey, accentColor }: ConsoleHeaderProps) {
  const workspace = process.cwd();
  const workspaceName = basename(workspace);

  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text>
        <Text color={accentColor}>▌</Text>
        <Text> </Text>
        <Text bold>ethos</Text>
        <Text dimColor> · model </Text>
        <Text>{model}</Text>
        <Text dimColor> · role </Text>
        <Text>{personality}</Text>
      </Text>
      <Text>
        <Text dimColor>workspace </Text>
        <Text>{workspaceName}</Text>
        <Text dimColor> · session </Text>
        <Text>{sessionKey}</Text>
        <Text dimColor> · env </Text>
        <Text>local</Text>
      </Text>
    </Box>
  );
}
