import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
export function SafetyLane({ readonlyMode, tags, focused = false }) {
    const tokens = useSkin();
    const colorFor = (tag) => {
        switch (tag) {
            case 'DESTRUCTIVE':
                return tokens.semantic.error;
            case 'APPROVAL_REQUIRED':
                return tokens.semantic.warning;
            case 'SUGGESTED':
                return tokens.semantic.info;
            default:
                return tokens.semantic.success;
        }
    };
    const counts = new Map([
        ['READ_ONLY', 0],
        ['SUGGESTED', 0],
        ['APPROVAL_REQUIRED', 0],
        ['DESTRUCTIVE', 0],
    ]);
    for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const activeTags = ['READ_ONLY', 'SUGGESTED', 'APPROVAL_REQUIRED', 'DESTRUCTIVE'].filter((tag) => (counts.get(tag) ?? 0) > 0);
    return (_jsxs(Box, { marginBottom: 1, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, color: focused ? tokens.semantic.info : undefined, children: ['─── ', _jsx(Text, { bold: true, color: focused ? tokens.semantic.info : tokens.surface.textPrimary, children: "safety" }), ' ───'] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: readonlyMode ? tokens.semantic.success : tokens.surface.textSecondary, children: readonlyMode ? 'READ-ONLY' : 'execution' }), activeTags.map((tag) => (_jsxs(Text, { color: colorFor(tag), children: [tag.toLowerCase().replace(/_/g, '-'), ": ", counts.get(tag) ?? 0] }, tag))), activeTags.length === 0 && _jsx(Text, { dimColor: true, children: "no active flags" })] }), _jsx(Text, { dimColor: true, children: "/readonly toggles execution lock" })] }));
}
