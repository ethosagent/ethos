import { formatContextWindow, getModelsForProvider } from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

export interface ModelEntry {
  id: string;
  provider: string;
  detail?: string;
}

// Derived from the wiring MODEL_CATALOG so the picker never drifts from setup.
const PICKER_PROVIDERS = ['anthropic', 'openai', 'codex', 'openrouter', 'ollama'];

// Built when the picker opens, not at module load: `getModelsForProvider` hides
// a row from its `retiresOn` date, so a TUI left running across that date must
// re-read the clock. Pinned by __tests__/model-picker-retirement.test.ts.
function knownModels(): ModelEntry[] {
  return PICKER_PROVIDERS.flatMap((provider) =>
    getModelsForProvider(provider).map((m) => ({
      provider,
      id: m.modelId,
      detail: `${m.label} · ${formatContextWindow(m.contextWindow)}${m.default ? ' · default' : ''}`,
    })),
  );
}

interface ModelPickerModalProps {
  current: string;
  onSelect: (model: ModelEntry) => void;
  onCancel: () => void;
}

export function ModelPickerModal({ current, onSelect, onCancel }: ModelPickerModalProps) {
  const [models] = useState(knownModels);
  const initial = models.findIndex((m) => m.id === current);
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
      setSelected((s) => Math.min(models.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const entry = models[selected];
      if (entry) onSelect(entry);
    }
  });

  // Group entries by provider for display, but keep single index for navigation.
  const providers = Array.from(new Set(models.map((m) => m.provider)));

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Pick a model</Text>
      <Box marginTop={1} flexDirection="column">
        {providers.map((provider) => (
          <Box key={provider} flexDirection="column" marginBottom={1}>
            <Text color="yellow" bold>
              {provider}
            </Text>
            {models
              .filter((m) => m.provider === provider)
              .map((m) => {
                const idx = models.indexOf(m);
                const isSelected = idx === selected;
                return (
                  <Box key={m.id} gap={1} paddingLeft={1}>
                    <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
                    <Text bold={isSelected}>{m.id}</Text>
                    {m.detail && <Text dimColor>— {m.detail}</Text>}
                    {m.id === current && <Text color="green">(current)</Text>}
                  </Box>
                );
              })}
          </Box>
        ))}
      </Box>
      <Text dimColor>↑/↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}
