import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

const OPTIONS = [
  {
    id: 'quick',
    label: 'Quick setup',
    hint: 'provider · key · model · personality · messaging  (~2 min)',
  },
  {
    id: 'full',
    label: 'Full setup',
    hint: 'adds fallback chain · key rotation · memory backend · daemon',
  },
];
export function SetupEntryStep() {
  const { dispatch } = useWizardContext();
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
    if (key.return) {
      const choice = OPTIONS[selected];
      if (choice) dispatch({ type: 'next', patch: { mode: choice.id } });
    }
  });
  return _jsxs(Box, {
    flexDirection: 'column',
    gap: 1,
    children: [
      _jsx(Text, {
        color: DESIGN.textPrimary,
        bold: true,
        children: 'How would you like to configure ethos?',
      }),
      _jsx(Box, {
        flexDirection: 'column',
        children: OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          return _jsxs(
            Box,
            {
              flexDirection: 'row',
              gap: 1,
              children: [
                _jsx(Text, { color: DESIGN.textPrimary, children: ` ${cursor} ` }),
                _jsxs(Box, {
                  flexDirection: 'column',
                  children: [
                    _jsx(Text, {
                      color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary,
                      bold: isSelected,
                      children: opt.label,
                    }),
                    _jsx(Text, { color: DESIGN.textTertiary, children: `    ${opt.hint}` }),
                  ],
                }),
              ],
            },
            opt.id,
          );
        }),
      }),
      _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter confirm' }),
    ],
  });
}
