import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

const KNOWN_MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-7', cost: '$15 / $75 per 1M' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', cost: '$3 / $15 per 1M' },
  { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', cost: '$0.25 / $1.25 per 1M' },
  { provider: 'openrouter', id: 'anthropic/claude-opus-4-7', cost: 'varies' },
  { provider: 'openrouter', id: 'anthropic/claude-sonnet-4-6', cost: 'varies' },
  { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', cost: 'varies' },
  { provider: 'openrouter', id: 'google/gemini-2.5-pro', cost: 'varies' },
  { provider: 'ollama', id: 'llama3.2', cost: 'free (local)' },
  { provider: 'ollama', id: 'mistral', cost: 'free (local)' },
  { provider: 'ollama', id: 'codestral', cost: 'free (local)' },
];
export function ModelPickerModal({ current, onSelect, onCancel }) {
  const initial = KNOWN_MODELS.findIndex((m) => m.id === current);
  const [selected, setSelected] = useState(initial >= 0 ? initial : 0);
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
      setSelected((s) => Math.min(KNOWN_MODELS.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const entry = KNOWN_MODELS[selected];
      if (entry) onSelect(entry);
    }
  });
  // Group entries by provider for display, but keep single index for navigation.
  const providers = Array.from(new Set(KNOWN_MODELS.map((m) => m.provider)));
  return _jsxs(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    paddingX: 1,
    children: [
      _jsx(Text, { bold: true, children: 'Pick a model' }),
      _jsx(Box, {
        marginTop: 1,
        flexDirection: 'column',
        children: providers.map((provider) =>
          _jsxs(
            Box,
            {
              flexDirection: 'column',
              marginBottom: 1,
              children: [
                _jsx(Text, { color: 'yellow', bold: true, children: provider }),
                KNOWN_MODELS.filter((m) => m.provider === provider).map((m) => {
                  const idx = KNOWN_MODELS.indexOf(m);
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
                        _jsx(Text, { bold: isSelected, children: m.id }),
                        m.cost && _jsxs(Text, { dimColor: true, children: ['\u2014 ', m.cost] }),
                        m.id === current && _jsx(Text, { color: 'green', children: '(current)' }),
                      ],
                    },
                    m.id,
                  );
                }),
              ],
            },
            provider,
          ),
        ),
      }),
      _jsx(Text, {
        dimColor: true,
        children: '\u2191/\u2193 navigate \u00B7 Enter select \u00B7 Esc cancel',
      }),
    ],
  });
}
