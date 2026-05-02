import {
  formatContextWindow,
  getDefaultModel,
  getModelsForProvider,
  MIN_CONTEXT_WINDOW,
} from '@ethosagent/wiring/model-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';

export function ModelStep() {
  const { answers, dispatch } = useWizardContext();
  const providerId = answers.provider ?? 'anthropic';
  const models = getModelsForProvider(providerId);
  const defaultModel = getDefaultModel(providerId);

  const [selected, setSelected] = useState(() => {
    const idx = models.findIndex(
      (m) => m.modelId === answers.model || (m.default && !answers.model),
    );
    return Math.max(0, idx);
  });

  useInput((_input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(models.length - 1, s + 1));
    if (key.return) {
      const m = models[selected] ?? defaultModel;
      if (m) dispatch({ type: 'next', patch: { model: m.modelId } });
    }
    if (key.escape) dispatch({ type: 'back' });
  });

  const selectedModel = models[selected];
  const showWarning = selectedModel && selectedModel.contextWindow < MIN_CONTEXT_WINDOW;

  // Fixed column widths for tabular display
  const idWidth = Math.max(...models.map((m) => m.modelId.length)) + 2;
  const labelWidth = Math.max(...models.map((m) => m.label.length)) + 2;

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        Choose a default model:
      </Text>
      <Box flexDirection="column">
        {models.map((m, i) => {
          const isSelected = i === selected;
          const cursor = isSelected ? GLYPHS.prompt : ' ';
          const isCurrent = answers.model === m.modelId;
          const ctxStr = formatContextWindow(m.contextWindow);
          return (
            <Box key={m.modelId} flexDirection="row" gap={1}>
              <Text color={DESIGN.textPrimary}>{` ${cursor} `}</Text>
              <Text
                color={isSelected ? DESIGN.textPrimary : DESIGN.textSecondary}
                bold={isSelected}
              >
                {m.modelId.padEnd(idWidth)}
              </Text>
              <Text color={DESIGN.textTertiary}>{m.label.padEnd(labelWidth)}</Text>
              <Text color={isCurrent ? DESIGN.success : DESIGN.textTertiary}>{ctxStr}</Text>
            </Box>
          );
        })}
      </Box>
      {showWarning && (
        <Text
          color={DESIGN.warning}
        >{`  ! ${selectedModel.contextWindow / 1_000}k ctx — researcher / engineer personalities work better at ≥64k`}</Text>
      )}
      {models.length === 0 && (
        <Box flexDirection="column">
          <Text color={DESIGN.textTertiary}>
            {'  No known models for this provider. Enter a model ID:'}
          </Text>
          <Text color={DESIGN.textTertiary}>{'  (free-form entry coming soon)'}</Text>
        </Box>
      )}
      <Text color={DESIGN.textTertiary}>{'  ↑↓ select   Enter confirm   Esc back'}</Text>
    </Box>
  );
}
