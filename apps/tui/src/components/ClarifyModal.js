import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

function formatCountdown(deadlineAt, now) {
  const ms = new Date(deadlineAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}
export function ClarifyModal({ request, onAnswer, onCancel }) {
  const options = request.options ?? [];
  const hasOptions = options.length > 0;
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // Live countdown — refresh once a second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (hasOptions) {
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(options.length - 1, s + 1));
        return;
      }
      if (key.return) {
        const choice = options[selected];
        if (choice !== undefined) onAnswer(choice);
        return;
      }
      return;
    }
    // Free-form text input.
    if (key.return) {
      if (text.trim()) onAnswer(text.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setText((t) => t + input);
    }
  });
  const countdown = formatCountdown(request.defaultDeadlineAt, now);
  const defaultHint =
    request.default !== undefined
      ? `default \`${request.default}\` in ${countdown}`
      : `times out in ${countdown}`;
  return _jsxs(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    paddingX: 1,
    children: [
      _jsxs(Text, { bold: true, color: 'yellow', children: ['? ', request.question] }),
      _jsx(Box, {
        marginTop: 1,
        flexDirection: 'column',
        children: hasOptions
          ? options.map((opt, idx) => {
              const isSelected = idx === selected;
              return _jsxs(
                Box,
                {
                  gap: 1,
                  paddingLeft: 1,
                  children: [
                    _jsx(Text, {
                      color: isSelected ? 'cyan' : undefined,
                      children: isSelected ? '▶' : ' ',
                    }),
                    _jsxs(Text, { bold: isSelected, children: [idx + 1, '. ', opt] }),
                  ],
                },
                opt,
              );
            })
          : _jsxs(Box, {
              paddingLeft: 1,
              children: [
                _jsx(Text, { children: text || ' ' }),
                _jsx(Text, { inverse: true, children: ' ' }),
              ],
            }),
      }),
      _jsx(Box, {
        marginTop: 1,
        children: _jsxs(Text, {
          dimColor: true,
          children: [
            hasOptions ? '↑/↓ navigate · Enter select' : 'type your answer · Enter submit',
            ' \u00B7 Esc cancel \u00B7 ',
            defaultHint,
          ],
        }),
      }),
    ],
  });
}
