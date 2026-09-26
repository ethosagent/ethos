import { slashCommandsForSurface } from '@ethosagent/surface-kit';
import { Box, Text } from 'ink';

export interface SlashCommand {
  name: string;
  desc: string;
}

// Derived from surface-kit's shared table filtered to 'tui' (C5) — the same
// source /help renders from (../help.ts), so no third hand-maintained list.
export const SLASH_COMMANDS: SlashCommand[] = slashCommandsForSurface('tui')
  .filter((cmd) => !cmd.aliasOf)
  .map((cmd) => ({ name: cmd.name, desc: cmd.description }));

export function getMatches(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const prefix = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

interface CompletionPanelProps {
  matches: SlashCommand[];
  selectedIndex: number;
}

export function CompletionPanel({ matches, selectedIndex }: CompletionPanelProps) {
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
      {matches.map((cmd, i) => (
        <Box key={cmd.name} gap={1}>
          <Text color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
            /{cmd.name}
          </Text>
          <Text dimColor>— {cmd.desc}</Text>
        </Box>
      ))}
      <Text dimColor>↑/↓ navigate · Tab/Enter select · Esc dismiss</Text>
    </Box>
  );
}
