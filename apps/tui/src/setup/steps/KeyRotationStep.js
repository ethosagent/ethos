import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
export function KeyRotationStep() {
  const { answers, accent, dispatch } = useWizardContext();
  const [phase, setPhase] = useState('list');
  const [keys, setKeys] = useState(answers.rotationKeys ?? []);
  const [input, setInput] = useState('');
  useInput((inputChar, key) => {
    if (phase === 'list') {
      if (key.return) {
        dispatch({ type: 'next', patch: { rotationKeys: keys } });
        return;
      }
      if (inputChar === 'a') {
        setPhase('add');
        setInput('');
        return;
      }
      if (key.escape) {
        dispatch({ type: 'back' });
        return;
      }
    }
    if (phase === 'add') {
      if (key.escape) {
        setPhase('list');
        return;
      }
      if (key.return) {
        if (input.trim()) {
          setKeys((k) => [...k, { apiKey: input.trim(), priority: k.length + 2 }]);
        }
        setPhase('list');
        return;
      }
      if (key.backspace || key.delete) {
        setInput((v) => v.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && inputChar) {
        setInput((v) => v + inputChar);
      }
    }
  });
  if (phase === 'add') {
    const masked =
      input.length > 0
        ? `${'•'.repeat(Math.min(input.length, 20))}${input.length > 20 ? ` (${input.length} chars)` : ''}`
        : '';
    return _jsxs(Box, {
      flexDirection: 'column',
      gap: 1,
      children: [
        _jsx(Text, { color: DESIGN.textPrimary, bold: true, children: 'Add a rotation key:' }),
        _jsxs(Box, {
          flexDirection: 'row',
          gap: 1,
          marginLeft: 2,
          children: [
            _jsx(Text, { color: accent, children: `${GLYPHS.prompt} ` }),
            _jsx(Text, {
              color: masked ? DESIGN.textPrimary : DESIGN.textTertiary,
              children: masked || '(paste key — input is hidden)',
            }),
          ],
        }),
        _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter save   Esc back' }),
      ],
    });
  }
  return _jsxs(Box, {
    flexDirection: 'column',
    gap: 1,
    children: [
      _jsx(Text, { color: DESIGN.textPrimary, bold: true, children: 'API key rotation pool:' }),
      _jsxs(Box, {
        flexDirection: 'column',
        marginLeft: 2,
        children: [
          _jsxs(Box, {
            flexDirection: 'row',
            gap: 1,
            children: [
              _jsx(Text, { color: DESIGN.success, children: `${GLYPHS.toolOk} ` }),
              _jsx(Text, { color: DESIGN.textPrimary, children: 'Primary key (already set)' }),
              _jsx(Text, { color: DESIGN.textTertiary, children: 'priority 1' }),
            ],
          }),
          keys.map((k, i) =>
            _jsxs(
              Box,
              {
                flexDirection: 'row',
                gap: 1,
                children: [
                  _jsx(Text, { color: DESIGN.textSecondary, children: `  ${GLYPHS.toolOk} ` }),
                  _jsx(Text, { color: DESIGN.textSecondary, children: `Key ${i + 2}` }),
                  _jsx(Text, { color: DESIGN.textTertiary, children: `priority ${k.priority}` }),
                ],
              },
              k.priority,
            ),
          ),
        ],
      }),
      _jsx(Box, {
        marginTop: 1,
        children: _jsx(Text, {
          color: DESIGN.textTertiary,
          children: '  a — add key   Enter done   Esc back',
        }),
      }),
      _jsx(Text, {
        color: DESIGN.textTertiary,
        children:
          '  Key material is stored in ~/.ethos/secrets/ (chmod 0600); rotation order in ~/.ethos/keys.json',
      }),
    ],
  });
}
