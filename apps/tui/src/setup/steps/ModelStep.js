import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { formatContextWindow, getDefaultModel, getModelsForProvider, MIN_CONTEXT_WINDOW, } from '@ethosagent/wiring/model-catalog';
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
        const idx = models.findIndex((m) => m.modelId === answers.model || (m.default && !answers.model));
        return Math.max(0, idx);
    });
    useInput((_input, key) => {
        if (key.upArrow)
            setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow)
            setSelected((s) => Math.min(models.length - 1, s + 1));
        if (key.return) {
            const m = models[selected] ?? defaultModel;
            if (m)
                dispatch({ type: 'next', patch: { model: m.modelId } });
        }
        if (key.escape)
            dispatch({ type: 'back' });
    });
    const selectedModel = models[selected];
    const showWarning = selectedModel && selectedModel.contextWindow < MIN_CONTEXT_WINDOW;
    // Fixed column widths for tabular display
    const idWidth = Math.max(...models.map((m) => m.modelId.length)) + 2;
    const labelWidth = Math.max(...models.map((m) => m.label.length)) + 2;
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Choose a default model:" }), _jsx(Box, { flexDirection: "column", children: models.map((m, i) => {
                    const isSelected = i === selected;
                    const cursor = isSelected ? GLYPHS.prompt : ' ';
                    const isCurrent = answers.model === m.modelId;
                    const ctxStr = formatContextWindow(m.contextWindow);
                    return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, children: ` ${cursor} ` }), _jsx(Text, { color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary, bold: isSelected, children: m.modelId.padEnd(idWidth) }), _jsx(Text, { color: DESIGN.textTertiary, children: m.label.padEnd(labelWidth) }), _jsx(Text, { color: isCurrent ? DESIGN.success : DESIGN.textTertiary, children: ctxStr })] }, m.modelId));
                }) }), showWarning && (_jsx(Text, { color: DESIGN.warning, children: `  ! ${selectedModel.contextWindow / 1_000}k ctx — researcher / engineer personalities work better at ≥64k` })), models.length === 0 && (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: DESIGN.textTertiary, children: '  No known models for this provider. Enter a model ID:' }), _jsx(Text, { color: DESIGN.textTertiary, children: '  (free-form entry coming soon)' })] })), _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter confirm   Esc back' })] }));
}
