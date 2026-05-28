import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '@ethosagent/wiring';
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

const PAGE_SIZE = 10;
export function SessionPickerModal({ onSelect, onCancel }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = createSessionStore({ dataDir: join(homedir(), '.ethos') });
        const list = await store.listSessions({ limit: 50 });
        if (!cancelled) setSessions(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(sessions.length - 1, s + 1));
      return;
    }
    if (key.return && sessions[selected]) {
      onSelect(sessions[selected]);
    }
  });
  if (loading) {
    return _jsx(Box, {
      children: _jsx(Text, { dimColor: true, children: 'Loading sessions\u2026' }),
    });
  }
  if (error) {
    return _jsxs(Box, {
      flexDirection: 'column',
      children: [
        _jsxs(Text, { color: 'red', children: ['Failed to load sessions: ', error] }),
        _jsx(Text, { dimColor: true, children: 'Press Esc to dismiss' }),
      ],
    });
  }
  if (sessions.length === 0) {
    return _jsxs(Box, {
      flexDirection: 'column',
      children: [
        _jsx(Text, { dimColor: true, children: 'No saved sessions yet.' }),
        _jsx(Text, { dimColor: true, children: 'Press Esc to dismiss' }),
      ],
    });
  }
  const start = Math.max(0, Math.min(sessions.length - PAGE_SIZE, selected - 4));
  const visible = sessions.slice(start, start + PAGE_SIZE);
  return _jsxs(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    paddingX: 1,
    children: [
      _jsxs(Text, { bold: true, children: ['Sessions (', sessions.length, ')'] }),
      _jsx(Box, {
        marginTop: 1,
        flexDirection: 'column',
        children: visible.map((s, i) => {
          const idx = start + i;
          const isSelected = idx === selected;
          const title = s.title ?? s.key;
          const tokens = s.usage.inputTokens + s.usage.outputTokens;
          return _jsxs(
            Box,
            {
              gap: 1,
              children: [
                _jsx(Text, {
                  color: isSelected ? 'cyan' : undefined,
                  children: isSelected ? '▶' : ' ',
                }),
                _jsx(Text, { bold: isSelected, wrap: 'truncate', children: title }),
                _jsxs(Text, {
                  dimColor: true,
                  children: [
                    '\u00B7 ',
                    s.platform,
                    ' \u00B7 ',
                    tokens.toLocaleString(),
                    ' tok \u00B7 $',
                    s.usage.estimatedCostUsd.toFixed(4),
                  ],
                }),
              ],
            },
            s.id,
          );
        }),
      }),
      _jsx(Box, {
        marginTop: 1,
        children: _jsx(Text, {
          dimColor: true,
          children: '\u2191/\u2193 navigate \u00B7 Enter resume \u00B7 Esc cancel',
        }),
      }),
    ],
  });
}
