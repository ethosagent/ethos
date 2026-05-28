import { Box, Text } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
export function AccordionSection({ title, mode, count, children }) {
  if (mode === 'hidden') return null;
  if (mode === 'collapsed') {
    return _jsx(Box, {
      marginBottom: 1,
      children: _jsxs(Text, {
        dimColor: true,
        children: ['\u25B6 ', title, count != null ? ` (${count})` : ''],
      }),
    });
  }
  return _jsxs(Box, {
    flexDirection: 'column',
    marginBottom: 1,
    children: [
      _jsxs(Text, { dimColor: true, children: ['\u25BC ', title] }),
      _jsx(Box, { flexDirection: 'column', paddingLeft: 2, children: children }),
    ],
  });
}
