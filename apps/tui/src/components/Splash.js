import { Box, Text } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { useSkin } from '../skin';

const MAX_VISIBLE_TOOLSETS = 4;
const MAX_NAMES_PER_TOOLSET = 5;
export function Splash({ model, personality, sessionKey, accentColor, inventory }) {
  const tokens = useSkin();
  const visibleToolsets = inventory.tools.slice(0, MAX_VISIBLE_TOOLSETS);
  const hiddenToolsets = Math.max(0, inventory.tools.length - MAX_VISIBLE_TOOLSETS);
  return _jsxs(Box, {
    flexDirection: 'column',
    marginBottom: 1,
    children: [
      _jsxs(Box, {
        marginBottom: 1,
        children: [
          _jsxs(Text, { color: accentColor, children: [tokens.glyphs.accentStripe, ' '] }),
          _jsx(Text, { bold: true, color: tokens.surface.textPrimary, children: 'ethos' }),
          _jsxs(Text, {
            color: tokens.surface.textSecondary,
            children: [' \u00B7 ', model, ' \u00B7 '],
          }),
          _jsx(Text, { color: accentColor, children: personality }),
          _jsx(Text, { color: tokens.surface.textTertiary, children: '  workspace ' }),
          _jsx(Text, {
            color: tokens.surface.textSecondary,
            children: sessionKey.replace(/^cli:/, '').replace(/:.*$/, ''),
          }),
          _jsx(Text, { color: tokens.surface.textTertiary, children: ' · session ' }),
          _jsx(Text, { color: tokens.surface.textSecondary, children: sessionKey }),
        ],
      }),
      _jsxs(Box, {
        marginBottom: 1,
        flexDirection: 'column',
        children: [
          _jsxs(Text, { color: accentColor, children: [tokens.glyphs.accentStripe, ' '] }),
          _jsxs(Text, {
            bold: true,
            color: tokens.surface.textPrimary,
            children: ['Tools (', inventory.totalTools, ')'],
          }),
          visibleToolsets.map((group) =>
            _jsxs(
              Box,
              {
                paddingLeft: 2,
                children: [
                  _jsx(Text, {
                    color: tokens.surface.textTertiary,
                    children: group.toolset.padEnd(16),
                  }),
                  _jsxs(Text, {
                    color: tokens.surface.textSecondary,
                    children: [
                      group.names.slice(0, MAX_NAMES_PER_TOOLSET).join(', '),
                      group.names.length > MAX_NAMES_PER_TOOLSET
                        ? ` · +${group.names.length - MAX_NAMES_PER_TOOLSET} more`
                        : '',
                    ],
                  }),
                ],
              },
              group.toolset,
            ),
          ),
          hiddenToolsets > 0 &&
            _jsx(Box, {
              paddingLeft: 2,
              children: _jsxs(Text, {
                dimColor: true,
                children: [
                  '(and ',
                  hiddenToolsets,
                  ' more toolset',
                  hiddenToolsets === 1 ? '' : 's',
                  ' \u2014 /tools to expand)',
                ],
              }),
            }),
        ],
      }),
      _jsxs(Box, {
        marginBottom: 1,
        children: [
          _jsxs(Text, { color: accentColor, children: [tokens.glyphs.accentStripe, ' '] }),
          _jsxs(Text, {
            bold: true,
            color: tokens.surface.textPrimary,
            children: ['Personalities (', inventory.personalities.length, ')'],
          }),
          _jsxs(Text, {
            color: tokens.surface.textSecondary,
            children: ['  ', inventory.personalities.join(' · ')],
          }),
          _jsxs(Text, { dimColor: true, children: [' /personality ', '<id>', ' to switch'] }),
        ],
      }),
      inventory.skills.length > 0 &&
        _jsxs(Box, {
          marginBottom: 1,
          children: [
            _jsxs(Text, { color: accentColor, children: [tokens.glyphs.accentStripe, ' '] }),
            _jsxs(Text, {
              bold: true,
              color: tokens.surface.textPrimary,
              children: ['Skills (', inventory.skills.length, ')'],
            }),
            _jsxs(Text, {
              color: tokens.surface.textSecondary,
              children: [
                '  ',
                inventory.skills.slice(0, 8).join(' · '),
                inventory.skills.length > 8 ? ` · +${inventory.skills.length - 8} more` : '',
              ],
            }),
            _jsx(Text, { dimColor: true, children: ' /skills to expand' }),
          ],
        }),
      inventory.mcpServers.length > 0 &&
        _jsxs(Box, {
          marginBottom: 1,
          children: [
            _jsxs(Text, { color: accentColor, children: [tokens.glyphs.accentStripe, ' '] }),
            _jsxs(Text, {
              bold: true,
              color: tokens.surface.textPrimary,
              children: ['MCP (', inventory.mcpServers.length, ')'],
            }),
            _jsxs(Text, {
              color: tokens.surface.textSecondary,
              children: ['  ', inventory.mcpServers.join(' · ')],
            }),
          ],
        }),
      _jsx(Box, {
        children: _jsx(Text, { dimColor: true, children: 'Type a message or /help to begin.' }),
      }),
    ],
  });
}
