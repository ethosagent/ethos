import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
const MAX_EVENTS = 24;
export function ExecutionTimeline({ events, focused = false }) {
    const tokens = useSkin();
    const colorFor = (level) => {
        switch (level) {
            case 'success':
                return tokens.semantic.success;
            case 'warning':
                return tokens.semantic.warning;
            case 'error':
                return tokens.semantic.error;
            default:
                return tokens.semantic.info;
        }
    };
    const visible = events.slice(-MAX_EVENTS);
    return (_jsxs(Box, { flexDirection: "column", marginLeft: 1, children: [_jsxs(Text, { dimColor: true, color: focused ? tokens.semantic.info : undefined, children: ['─── ', _jsx(Text, { bold: true, color: focused ? tokens.semantic.info : tokens.surface.textPrimary, children: "execution" }), ' ───'] }), visible.length === 0 ? (_jsx(Text, { dimColor: true, children: "no activity yet" })) : (visible.map((event) => (_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: event.at }), _jsx(Text, { children: " " }), _jsx(Text, { color: colorFor(event.level), children: event.text })] }, event.id))))] }));
}
