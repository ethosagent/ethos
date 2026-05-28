import { Box, Text } from 'ink';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { useSkin } from '../skin';
import { PersonalityMark } from './PersonalityMark';

function modeFromStatus(status) {
  switch (status) {
    case 'running':
      return 'execution';
    case 'thinking':
      return 'analysis';
    case 'interrupted':
      return 'paused';
    default:
      return 'ready';
  }
}
export function IdentityPanel({
  personality,
  status,
  delegationCount,
  accentColor,
  focused = false,
}) {
  const tokens = useSkin();
  return _jsxs(Box, {
    borderStyle: 'single',
    borderColor: focused ? tokens.semantic.info : tokens.surface.borderSubtle,
    paddingX: 1,
    paddingY: 1,
    flexDirection: 'column',
    marginRight: 1,
    children: [
      _jsx(PersonalityMark, { personality: personality, accentColor: accentColor }),
      _jsx(Text, { bold: true, color: accentColor, children: personality }),
      _jsxs(Text, { dimColor: true, children: ['mode: ', modeFromStatus(status)] }),
      _jsxs(Text, { dimColor: true, children: ['status: ', status] }),
      _jsxs(Text, { dimColor: true, children: ['delegations: ', delegationCount] }),
      _jsx(Text, { dimColor: true, children: 'services: local bridge' }),
    ],
  });
}
