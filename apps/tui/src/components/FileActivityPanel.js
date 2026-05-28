import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
const MAX_ENTRIES = 20;
function actionGlyph(action) {
    switch (action) {
        case 'write':
            return '✎';
        case 'patch':
            return '✏';
        default:
            return '◎';
    }
}
function InlineDiff({ diff, maxLines = 8 }) {
    const tokens = useSkin();
    const lines = diff
        .split('\n')
        .filter((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@'));
    const visible = lines.slice(0, maxLines);
    const truncated = lines.length > maxLines;
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [visible.map((line, i) => {
                const color = line.startsWith('+')
                    ? tokens.semantic.success
                    : line.startsWith('-')
                        ? tokens.semantic.error
                        : tokens.surface.textSecondary;
                return (_jsx(Text, { color: color, children: line.slice(0, 100) }, i));
            }), truncated && _jsxs(Text, { dimColor: true, children: ["(", lines.length - maxLines, " more lines)"] })] }));
}
export function FileActivityPanel({ entries, focused = false, selectedId, }) {
    const tokens = useSkin();
    const colorFor = (status) => {
        switch (status) {
            case 'approval_required':
                return tokens.semantic.warning;
            case 'approved':
                return tokens.semantic.success;
            case 'denied':
                return tokens.semantic.error;
            case 'done':
                return tokens.semantic.success;
            case 'error':
                return tokens.semantic.error;
            default:
                return tokens.semantic.warning;
        }
    };
    const visible = entries.slice(-MAX_ENTRIES);
    const pendingPatches = visible.filter((e) => e.status === 'approval_required').length;
    return (_jsxs(Box, { marginBottom: 1, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, color: focused ? tokens.semantic.info : undefined, children: ['─── ', _jsx(Text, { bold: true, color: focused ? tokens.semantic.info : tokens.surface.textPrimary, children: "file activity" }), ' ───'] }), pendingPatches > 0 && (_jsxs(Text, { color: tokens.semantic.warning, dimColor: true, children: [pendingPatches, " pending \u00B7 a=approve d=deny"] })), visible.length === 0 ? (_jsx(Text, { dimColor: true, children: "no file activity yet" })) : (visible.map((entry) => (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: entry.at }), _jsx(Text, { children: " " }), _jsxs(Text, { color: colorFor(entry.status), inverse: entry.id === selectedId, children: [actionGlyph(entry.action), " ", entry.action, " ", entry.path, " [", entry.status, "]"] })] }), entry.diff && entry.id === selectedId && _jsx(InlineDiff, { diff: entry.diff })] }, entry.id))))] }));
}
