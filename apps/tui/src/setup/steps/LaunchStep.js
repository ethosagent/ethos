import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
export function LaunchStep(_props) {
    const { accent, dispatch } = useWizardContext();
    const [choice, setChoice] = useState('yes');
    useInput((input, key) => {
        if (key.leftArrow || input === 'h' || input === 'y')
            setChoice('yes');
        if (key.rightArrow || input === 'l' || input === 'n')
            setChoice('no');
        if (key.return) {
            dispatch({ type: 'next', patch: { launchChat: choice === 'yes' } });
        }
        if (key.escape)
            dispatch({ type: 'back' });
    });
    return (_jsxs(Box, { flexDirection: "column", gap: 1, children: [_jsx(Text, { color: DESIGN.textPrimary, bold: true, children: "Launch chat now?" }), _jsxs(Box, { flexDirection: "row", gap: 2, marginLeft: 2, children: [_jsx(Text, { color: choice === 'yes' ? accent : DESIGN.textTertiary, bold: choice === 'yes', children: choice === 'yes' ? `${GLYPHS.prompt} Y` : '  Y' }), _jsx(Text, { color: DESIGN.textTertiary, children: '/' }), _jsx(Text, { color: choice === 'no' ? accent : DESIGN.textTertiary, bold: choice === 'no', children: choice === 'no' ? `${GLYPHS.prompt} n` : '  n' })] }), _jsx(Text, { color: DESIGN.textTertiary, children: '  ←/→ or y/n   Enter confirm   Esc back' }), choice === 'no' && (_jsx(Text, { color: DESIGN.textTertiary, children: '  Run `ethos` to start chatting.' }))] }));
}
