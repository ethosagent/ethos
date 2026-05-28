import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

function nextEnabled(entries, from, dir) {
  let i = from + dir;
  while (i >= 0 && i < entries.length) {
    if (!entries[i]?.comingSoon) return i;
    i += dir;
  }
  return from;
}
export function ProviderStep() {
  const { answers, dispatch } = useWizardContext();
  const [selected, setSelected] = useState(() => {
    const idx = PROVIDER_CATALOG.findIndex((e) => e.id === (answers.provider ?? 'anthropic'));
    return idx >= 0 ? idx : 0;
  });
  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => nextEnabled(PROVIDER_CATALOG, s, -1));
    if (key.downArrow) setSelected((s) => nextEnabled(PROVIDER_CATALOG, s, 1));
    if (key.return) {
      const entry = PROVIDER_CATALOG[selected];
      if (entry && !entry.comingSoon) {
        dispatch({ type: 'next', patch: { provider: entry.id, baseUrl: entry.defaultBaseUrl } });
      }
    }
    if (key.escape) dispatch({ type: 'back' });
    void input;
  });
  return _jsxs(Box, {
    flexDirection: 'column',
    gap: 1,
    children: [
      _jsx(Text, { color: DESIGN.textPrimary, bold: true, children: 'Choose a provider:' }),
      _jsx(Box, {
        flexDirection: 'column',
        children: PROVIDER_CATALOG.map((entry, i) => {
          const isSelected = i === selected;
          const isDisabled = Boolean(entry.comingSoon);
          const cursor = isSelected && !isDisabled ? GLYPHS.prompt : ' ';
          const isCurrent = answers.provider === entry.id;
          const labelColor = isDisabled
            ? DESIGN.textTertiary
            : isSelected
              ? DESIGN.textPrimary
              : DESIGN.textSecondary;
          return _jsxs(
            Box,
            {
              flexDirection: 'column',
              children: [
                _jsxs(Box, {
                  flexDirection: 'row',
                  gap: 1,
                  children: [
                    _jsx(Text, {
                      color: isDisabled ? DESIGN.textTertiary : DESIGN.textPrimary,
                      children: ` ${cursor} `,
                    }),
                    _jsx(Text, {
                      color: labelColor,
                      bold: isSelected && !isDisabled,
                      dimColor: isDisabled,
                      children: entry.label,
                    }),
                    isDisabled &&
                      _jsx(Text, {
                        color: DESIGN.textTertiary,
                        dimColor: true,
                        children: '(coming soon)',
                      }),
                    !isDisabled &&
                      isCurrent &&
                      _jsx(Text, { color: DESIGN.textTertiary, children: '(current)' }),
                    !isDisabled &&
                      _jsx(Text, { color: DESIGN.textTertiary, children: entry.costType }),
                  ],
                }),
                isSelected &&
                  !isDisabled &&
                  _jsx(Text, {
                    color: DESIGN.textTertiary,
                    children: `      ${entry.description}`,
                  }),
              ],
            },
            entry.id,
          );
        }),
      }),
      _jsx(Text, {
        color: DESIGN.textTertiary,
        children: '  ↑↓ select   Enter confirm   Esc back',
      }),
    ],
  });
}
