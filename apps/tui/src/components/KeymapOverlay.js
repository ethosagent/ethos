import { Box, Text } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
export function KeymapOverlay({ focusPane, running }) {
  return _jsxs(Box, {
    borderStyle: 'double',
    borderColor: 'cyan',
    paddingX: 1,
    paddingY: 1,
    flexDirection: 'column',
    children: [
      _jsx(Text, { bold: true, children: 'keyboard map' }),
      _jsxs(Text, { dimColor: true, children: ['focus: ', focusPane] }),
      _jsxs(Text, { dimColor: true, children: ['state: ', running ? 'running' : 'idle'] }),
      _jsx(Text, { children: 'Tab / Shift+Tab cycle pane focus' }),
      _jsx(Text, { children: '? toggle this overlay' }),
      _jsx(Text, { children: 'Esc close overlay' }),
      _jsx(Text, { children: 'Ctrl+C abort turn or exit' }),
      _jsx(Text, { children: 'Enter submit input (input focus)' }),
      _jsx(Text, { children: 'Up/Down history or completion (input focus)' }),
      _jsx(Text, { children: 'Tab slash completion when popup visible' }),
      _jsx(Text, { children: 'a / d approve or deny pending patch (files focus)' }),
      _jsx(Text, { dimColor: true, children: 'Press ? or Esc to return.' }),
    ],
  });
}
