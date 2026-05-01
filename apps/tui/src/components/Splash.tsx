import { Box, Text } from 'ink';
import { DESIGN, GLYPHS } from '../skin';

export interface ToolGroupEntry {
  toolset: string;
  names: string[];
}

export interface SplashInventory {
  tools: ToolGroupEntry[];
  totalTools: number;
  personalities: string[];
  skills: string[];
  mcpServers: string[];
}

interface SplashProps {
  model: string;
  personality: string;
  sessionKey: string;
  accentColor: string;
  inventory: SplashInventory;
}

const MAX_VISIBLE_TOOLSETS = 4;
const MAX_NAMES_PER_TOOLSET = 5;

export function Splash({ model, personality, sessionKey, accentColor, inventory }: SplashProps) {
  const visibleToolsets = inventory.tools.slice(0, MAX_VISIBLE_TOOLSETS);
  const hiddenToolsets = Math.max(0, inventory.tools.length - MAX_VISIBLE_TOOLSETS);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color={accentColor}>{GLYPHS.accentStripe} </Text>
        <Text bold color={DESIGN.textPrimary}>
          ethos
        </Text>
        <Text color={DESIGN.textSecondary}> · {model} · </Text>
        <Text color={accentColor}>{personality}</Text>
        <Text color={DESIGN.textTertiary}>{'  workspace '}</Text>
        <Text color={DESIGN.textSecondary}>
          {sessionKey.replace(/^cli:/, '').replace(/:.*$/, '')}
        </Text>
        <Text color={DESIGN.textTertiary}>{' · session '}</Text>
        <Text color={DESIGN.textSecondary}>{sessionKey}</Text>
      </Box>

      {/* Tools section */}
      <Box marginBottom={1} flexDirection="column">
        <Text color={accentColor}>{GLYPHS.accentStripe} </Text>
        <Text bold color={DESIGN.textPrimary}>
          Tools ({inventory.totalTools})
        </Text>
        {visibleToolsets.map((group) => (
          <Box key={group.toolset} paddingLeft={2}>
            <Text color={DESIGN.textTertiary}>{group.toolset.padEnd(16)}</Text>
            <Text color={DESIGN.textSecondary}>
              {group.names.slice(0, MAX_NAMES_PER_TOOLSET).join(', ')}
              {group.names.length > MAX_NAMES_PER_TOOLSET
                ? ` · +${group.names.length - MAX_NAMES_PER_TOOLSET} more`
                : ''}
            </Text>
          </Box>
        ))}
        {hiddenToolsets > 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>
              (and {hiddenToolsets} more toolset{hiddenToolsets === 1 ? '' : 's'} — /tools to
              expand)
            </Text>
          </Box>
        )}
      </Box>

      {/* Personalities section */}
      <Box marginBottom={1}>
        <Text color={accentColor}>{GLYPHS.accentStripe} </Text>
        <Text bold color={DESIGN.textPrimary}>
          Personalities ({inventory.personalities.length})
        </Text>
        <Text color={DESIGN.textSecondary}>
          {'  '}
          {inventory.personalities.join(' · ')}
        </Text>
        <Text dimColor> /personality {'<id>'} to switch</Text>
      </Box>

      {/* Skills section */}
      {inventory.skills.length > 0 && (
        <Box marginBottom={1}>
          <Text color={accentColor}>{GLYPHS.accentStripe} </Text>
          <Text bold color={DESIGN.textPrimary}>
            Skills ({inventory.skills.length})
          </Text>
          <Text color={DESIGN.textSecondary}>
            {'  '}
            {inventory.skills.slice(0, 8).join(' · ')}
            {inventory.skills.length > 8 ? ` · +${inventory.skills.length - 8} more` : ''}
          </Text>
          <Text dimColor> /skills to expand</Text>
        </Box>
      )}

      {/* MCP section */}
      {inventory.mcpServers.length > 0 && (
        <Box marginBottom={1}>
          <Text color={accentColor}>{GLYPHS.accentStripe} </Text>
          <Text bold color={DESIGN.textPrimary}>
            MCP ({inventory.mcpServers.length})
          </Text>
          <Text color={DESIGN.textSecondary}>
            {'  '}
            {inventory.mcpServers.join(' · ')}
          </Text>
        </Box>
      )}

      <Box>
        <Text dimColor>Type a message or /help to begin.</Text>
      </Box>
    </Box>
  );
}
