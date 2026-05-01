import { Box, Text } from 'ink';

interface KeymapOverlayProps {
  focusPane: string;
  running: boolean;
}

export function KeymapOverlay({ focusPane, running }: KeymapOverlayProps) {
  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={1} paddingY={1} flexDirection="column">
      <Text bold>keyboard map</Text>
      <Text dimColor>focus: {focusPane}</Text>
      <Text dimColor>state: {running ? 'running' : 'idle'}</Text>
      <Text>Tab / Shift+Tab cycle pane focus</Text>
      <Text>? toggle this overlay</Text>
      <Text>Esc close overlay</Text>
      <Text>Ctrl+C abort turn or exit</Text>
      <Text>Enter submit input (input focus)</Text>
      <Text>Up/Down history or completion (input focus)</Text>
      <Text>Tab slash completion when popup visible</Text>
      <Text>a / d approve or deny pending patch (files focus)</Text>
      <Text dimColor>Press ? or Esc to return.</Text>
    </Box>
  );
}
