import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
const OPTIONS = [
    { id: 'markdown', label: 'Markdown (default)', hint: 'file-based, always available' },
    { id: 'vector', label: 'Vector (semantic)', hint: 'requires @ethosagent/memory-vector' },
];
export function MemoryStep() {
    const { answers, accent, dispatch } = useWizardContext();
    const [selected, setSelected] = useState(() => {
        const idx = OPTIONS.findIndex((o) => o.id === answers.memory);
        return idx >= 0 ? idx : 0;
    });
    useInput((_input, key) => {
        if (key.upArrow)
            setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow)
            setSelected((s) => Math.min(OPTIONS.length - 1, s + 1));
        if (key.return) {
            const opt = OPTIONS[selected];
            if (opt)
                dispatch({ type: 'next', patch: { memory: opt.id } });
        }
        if (key.escape)
            dispatch({ type: 'back' });
    });
    const selectedOpt = OPTIONS[selected];
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Choose a memory backend:" }), _jsx(Box, { flexDirection: "column", children: OPTIONS.map((opt, i) => {
                    const isSelected = i === selected;
                    const cursor = isSelected ? GLYPHS.prompt : ' ';
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isSelected ? accent : DESIGN.textTertiary, children: ` ${cursor} ` }), _jsx(Text, { color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary, bold: isSelected, children: opt.label })] }), isSelected && _jsx(Text, { color: DESIGN.textTertiary, children: `      ${opt.hint}` })] }, opt.id));
                }) }), selectedOpt?.id === 'vector' && (_jsx(Text, { color: DESIGN.textTertiary, children: '  Install: pnpm add @ethosagent/memory-vector' })), _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter confirm   Esc back' })] }));
}
