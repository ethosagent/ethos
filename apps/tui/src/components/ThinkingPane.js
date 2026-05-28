import { Box, Text } from 'ink';
import { jsx as _jsx } from 'react/jsx-runtime';
import { useSkin } from '../skin';
export function ThinkingPane({ text }) {
  const tokens = useSkin();
  if (!text) return null;
  return _jsx(Box, {
    flexDirection: 'column',
    children: text
      .split('\n')
      .map((line, i) =>
        _jsx(
          Text,
          { color: tokens.accents.coach, dimColor: true, wrap: 'wrap', children: line },
          i,
        ),
      ),
  });
}
