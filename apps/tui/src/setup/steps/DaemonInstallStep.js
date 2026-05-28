import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

const OPTIONS = [
  {
    id: 'install',
    label: 'Install gateway daemon',
    hint: 'systemd (Linux) / LaunchAgent (macOS) — survives reboot',
  },
  {
    id: 'skip',
    label: 'Skip',
    hint: 'run `ethos gateway start` manually',
  },
];
export function DaemonInstallStep() {
  const { accent, dispatch } = useWizardContext();
  const [selected, setSelected] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
    if (key.return) {
      // Daemon install happens post-wizard via CLI; we just record the intent.
      dispatch({ type: 'next', patch: {} });
    }
    if (key.escape) dispatch({ type: 'back' });
  });
  const platform = process.platform === 'darwin' ? 'macOS LaunchAgent' : 'systemd user unit';
  return _jsxs(Box, {
    flexDirection: 'column',
    gap: 1,
    children: [
      _jsx(Text, { color: DESIGN.textPrimary, bold: true, children: 'Gateway daemon:' }),
      _jsx(Text, { color: DESIGN.textTertiary, children: `  Detected: ${platform}` }),
      _jsx(Box, {
        flexDirection: 'column',
        marginTop: 1,
        children: OPTIONS.map((opt, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
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
                      color: isSelected ? accent : DESIGN.textTertiary,
                      children: ` ${cursor} `,
                    }),
                    _jsx(Text, {
                      color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary,
                      bold: isSelected,
                      children: opt.label,
                    }),
                  ],
                }),
                isSelected &&
                  _jsx(Text, { color: DESIGN.textTertiary, children: `      ${opt.hint}` }),
              ],
            },
            opt.id,
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
