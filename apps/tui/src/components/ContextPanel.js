import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
export function ContextPanel({ activeTools, completedTools, queueDepth, messageCount, pendingPatchCount, focused = false, }) {
    const tokens = useSkin();
    const activeNames = activeTools.slice(-3).map((t) => t.toolName);
    return (_jsxs(Box, { marginBottom: 1, flexDirection: "column", children: [_jsxs(Text, { dimColor: true, color: focused ? tokens.semantic.info : undefined, children: ['─── ', _jsx(Text, { bold: true, color: focused ? tokens.semantic.info : tokens.surface.textPrimary, children: "context" }), ' ───'] }), _jsxs(Text, { dimColor: true, children: ["messages: ", messageCount, " \u00B7 queue: ", queueDepth, " \u00B7 active: ", activeTools.length, " \u00B7 completed:", ' ', completedTools.length, pendingPatchCount > 0 ? ` · pending: ${pendingPatchCount}` : ''] }), activeNames.length > 0 && _jsxs(Text, { dimColor: true, children: ["now: ", activeNames.join(', ')] })] }));
}
