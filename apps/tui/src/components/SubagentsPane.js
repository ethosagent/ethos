import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
const MAX_VISIBLE = 16;
export function SubagentsPane({ delegations }) {
    const tokens = useSkin();
    if (delegations.length === 0)
        return null;
    const visible = delegations.slice(-MAX_VISIBLE);
    return (_jsx(Box, { flexDirection: "column", children: visible.map((d) => (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: d.status === 'done'
                                ? tokens.semantic.success
                                : d.status === 'failed'
                                    ? tokens.semantic.error
                                    : tokens.semantic.warning, children: d.status === 'done'
                                ? tokens.glyphs.toolOk
                                : d.status === 'failed'
                                    ? tokens.glyphs.toolFail
                                    : '…' }), _jsxs(Text, { dimColor: true, children: [d.capability, d.durationMs != null ? ` ${d.durationMs}ms` : ''] })] }), d.status === 'failed' && d.error && (_jsxs(Text, { color: tokens.semantic.error, children: [" reason: ", d.error.slice(0, 96)] }))] }, d.id))) }));
}
