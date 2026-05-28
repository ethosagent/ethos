import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';
import { useSkin } from '../skin';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function Spinner() {
  const tokens = useSkin();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return _jsx(Text, { color: tokens.semantic.info, children: FRAMES[frame] });
}
function ProgressBar({ percent }) {
  const tokens = useSkin();
  const filled = Math.round(percent / 10);
  const bar = tokens.glyphs.barFill.repeat(filled) + tokens.glyphs.barEmpty.repeat(10 - filled);
  return _jsx(Text, { dimColor: true, children: bar });
}
export function ToolSpinner({ activeTools, completedTools }) {
  const tokens = useSkin();
  if (activeTools.length === 0 && completedTools.length === 0) return null;
  return _jsxs(Box, {
    flexDirection: 'column',
    children: [
      completedTools.map((t) =>
        _jsxs(
          Box,
          {
            gap: 1,
            children: [
              _jsx(Text, {
                color: t.ok ? tokens.semantic.success : tokens.semantic.error,
                children: t.ok ? tokens.glyphs.toolOk : tokens.glyphs.toolFail,
              }),
              _jsxs(Text, {
                dimColor: true,
                children: [tokens.glyphs.toolStart, ' ', t.toolName, ' ', t.durationMs, 'ms'],
              }),
            ],
          },
          t.id,
        ),
      ),
      activeTools.map((t) =>
        _jsxs(
          Box,
          {
            gap: 1,
            children: [
              _jsx(Spinner, {}),
              _jsxs(Text, {
                dimColor: true,
                children: [
                  tokens.glyphs.toolStart,
                  ' ',
                  t.toolName,
                  t.message ? ` — ${t.message}` : '',
                ],
              }),
              t.percent != null && _jsx(ProgressBar, { percent: t.percent }),
            ],
          },
          t.toolCallId,
        ),
      ),
    ],
  });
}
