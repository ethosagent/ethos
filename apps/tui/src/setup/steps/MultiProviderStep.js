import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
export function MultiProviderStep() {
    const { answers, accent, dispatch } = useWizardContext();
    const [phase, setPhase] = useState('list');
    const [providerIdx, setProviderIdx] = useState(0);
    const [apiKey, setApiKey] = useState('');
    const [providers, setProviders] = useState(answers.providers ?? []);
    useInput((input, key) => {
        if (phase === 'list') {
            if (key.return) {
                dispatch({ type: 'next', patch: { providers } });
                return;
            }
            if (input === 'a') {
                setPhase('add-provider');
                setProviderIdx(0);
                return;
            }
            if (key.escape) {
                dispatch({ type: 'back' });
                return;
            }
        }
        if (phase === 'add-provider') {
            if (key.upArrow)
                setProviderIdx((i) => Math.max(0, i - 1));
            if (key.downArrow)
                setProviderIdx((i) => Math.min(PROVIDER_CATALOG.length - 1, i + 1));
            if (key.return) {
                setPhase('add-key');
                setApiKey('');
                return;
            }
            if (key.escape) {
                setPhase('list');
                return;
            }
        }
        if (phase === 'add-key') {
            if (key.escape) {
                setPhase('add-provider');
                return;
            }
            if (key.return) {
                const entry = PROVIDER_CATALOG[providerIdx];
                if (entry) {
                    setProviders((p) => [
                        ...p,
                        { provider: entry.id, apiKey, baseUrl: entry.defaultBaseUrl },
                    ]);
                }
                setPhase('list');
                return;
            }
            if (key.backspace || key.delete) {
                setApiKey((k) => k.slice(0, -1));
                return;
            }
            if (!key.ctrl && !key.meta && input) {
                setApiKey((k) => k + input);
            }
        }
    });
    if (phase === 'add-provider') {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Add a fallback provider:" }), _jsx(Box, { flexDirection: "column", children: PROVIDER_CATALOG.map((p, i) => {
                        const isSelected = i === providerIdx;
                        const cursor = isSelected ? GLYPHS.prompt : ' ';
                        return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isSelected ? accent : DESIGN.textTertiary, children: ` ${cursor} ` }), _jsx(Text, { color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary, children: p.label })] }, p.id));
                    }) }), _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter next   Esc back' })] }));
    }
    if (phase === 'add-key') {
        const entry = PROVIDER_CATALOG[providerIdx];
        const masked = apiKey.length > 0
            ? `${'•'.repeat(Math.min(apiKey.length, 20))}${apiKey.length > 20 ? ` (${apiKey.length} chars)` : ''}`
            : '';
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: `API key for ${entry?.label ?? ''}:` }), _jsxs(Box, { flexDirection: "row", gap: 1, marginLeft: 2, children: [_jsx(Text, { color: accent, children: `${GLYPHS.prompt} ` }), _jsx(Text, { color: masked ? DESIGN.textPrimary : DESIGN.textTertiary, children: masked || '(paste key — input is hidden)' })] }), _jsx(Text, { color: DESIGN.textTertiary, children: '  Enter confirm   Esc back' })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Fallback provider chain:" }), _jsxs(Box, { flexDirection: "column", marginLeft: 2, children: [_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: DESIGN.success, children: `${GLYPHS.toolOk} ` }), _jsx(Text, { color: DESIGN.textPrimary, children: `${answers.provider ?? 'anthropic'}` }), _jsx(Text, { color: DESIGN.textTertiary, children: '(primary)' })] }), providers.map((p, i) => (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: DESIGN.textSecondary, children: `  ${i + 1}. ` }), _jsx(Text, { color: DESIGN.textSecondary, children: p.provider }), _jsx(Text, { color: DESIGN.textTertiary, children: '(fallback)' })] }, `${p.provider}-${i}`)))] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: DESIGN.textTertiary, children: '  a — add fallback   Enter done   Esc back' }) })] }));
}
