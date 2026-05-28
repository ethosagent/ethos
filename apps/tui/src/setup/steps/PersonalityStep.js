import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { personalityAccent } from '@ethosagent/design-tokens';
import { generatePersonalityMark } from '@ethosagent/web-contracts';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
const PERSONALITIES = [
    { id: 'researcher', description: 'deep reads, slow takes, links sources' },
    { id: 'engineer', description: 'ship working code, terse, runs tests' },
    { id: 'reviewer', description: 'diff-aware, surfaces tradeoffs' },
    { id: 'coach', description: 'asks back, helps you think out loud' },
    { id: 'operator', description: 'plans, schedules, dispatches' },
    { id: 'coordinator', description: 'delegates across team meshes' },
];
function opacityToChar(opacity) {
    if (opacity >= 0.93)
        return '█';
    if (opacity >= 0.81)
        return '▓';
    if (opacity >= 0.68)
        return '▒';
    if (opacity >= 0.55)
        return '░';
    return ' ';
}
function getMarkSlice(id) {
    const spec = generatePersonalityMark(id);
    const row0 = Array(4).fill(' ');
    for (const cell of spec.cells) {
        if (cell.row === 0 && cell.col < 4) {
            row0[cell.col] = opacityToChar(cell.opacity);
        }
    }
    return row0.join('');
}
function FullMarkPreview({ id }) {
    const spec = generatePersonalityMark(id);
    const accent = personalityAccent(id);
    const grid = Array.from({ length: 5 }, () => Array(5).fill(' '));
    for (const cell of spec.cells) {
        if (cell.row < 5 && cell.col < 5) {
            grid[cell.row][cell.col] = opacityToChar(cell.opacity);
        }
    }
    return (_jsx(Box, { flexDirection: "column", marginLeft: 4, children: grid.map((row, r) => (_jsx(Text, { color: accent, children: row.join('') }, r))) }));
}
export function PersonalityStep() {
    const { answers, accent, dispatch } = useWizardContext();
    const [selected, setSelected] = useState(() => {
        const idx = PERSONALITIES.findIndex((p) => p.id === answers.personality);
        return idx >= 0 ? idx : 0;
    });
    const [previewing, setPreviewing] = useState(false);
    useInput((input, key) => {
        if (previewing) {
            if (key.escape || input === ' ')
                setPreviewing(false);
            return;
        }
        if (key.upArrow)
            setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow)
            setSelected((s) => Math.min(PERSONALITIES.length - 1, s + 1));
        if (input === ' ')
            setPreviewing(true);
        if (key.return) {
            const p = PERSONALITIES[selected];
            if (p)
                dispatch({ type: 'next', patch: { personality: p.id } });
        }
        if (key.escape)
            dispatch({ type: 'back' });
    });
    const selectedEntry = PERSONALITIES[selected];
    const cursorAccent = selectedEntry ? personalityAccent(selectedEntry.id) : accent;
    if (previewing && selectedEntry) {
        return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: selectedEntry.id }), _jsx(FullMarkPreview, { id: selectedEntry.id }), _jsx(Text, { color: DESIGN.textTertiary, children: '  Esc or Space to close preview' })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Choose a default personality:" }), _jsx(Box, { flexDirection: "column", children: PERSONALITIES.map((p, i) => {
                    const isSelected = i === selected;
                    const pAccent = personalityAccent(p.id);
                    const cursor = isSelected ? GLYPHS.prompt : ' ';
                    const markSlice = getMarkSlice(p.id);
                    return (_jsxs(Box, { flexDirection: "row", gap: 1, children: [_jsx(Text, { color: isSelected ? cursorAccent : DESIGN.textTertiary, children: ` ${cursor} ` }), _jsx(Text, { color: pAccent, children: markSlice }), _jsx(Text, { color: pAccent, children: GLYPHS.accentStripe }), _jsx(Text, { color: isSelected ? DESIGN.textPrimary : DESIGN.textSecondary, bold: isSelected, children: p.id.padEnd(12) }), _jsx(Text, { color: DESIGN.textTertiary, children: p.description })] }, p.id));
                }) }), _jsx(Text, { color: DESIGN.textTertiary, children: '  ↑↓ select   Enter confirm   Space ▤ preview   Esc back' })] }));
}
