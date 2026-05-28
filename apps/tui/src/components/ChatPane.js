import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useSkin } from '../skin';
// A single chat row. Used inside Ink's <Static> in App.tsx so settled
// messages print once to terminal scrollback and never re-render — that's
// what prevents the dynamic Ink frame from growing past the terminal
// viewport height (which previously caused the chrome to print twice on
// every turn).
export function ChatRow({ message, accentColor }) {
    const tokens = useSkin();
    return (_jsx(Box, { flexDirection: "column", marginBottom: 1, children: message.role === 'user' ? (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: tokens.semantic.info, bold: true, children: "You" }), _jsx(Text, { dimColor: true, children: tokens.glyphs.prompt }), _jsx(Text, { wrap: "wrap", children: message.text })] })) : (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: message.accentColor ?? accentColor ?? tokens.semantic.success, children: tokens.glyphs.accentStripe }), _jsx(Text, { bold: true, color: tokens.surface.textPrimary, children: "ethos" }), _jsx(Text, { dimColor: true, children: tokens.glyphs.prompt }), _jsx(Text, { wrap: "wrap", children: message.text })] })) }));
}
// The in-flight assistant message. Renders inside the dynamic frame —
// re-renders on every text_delta as the model streams. On `done`, App.tsx
// flushes this text into the committed-messages list (which prints via
// <Static>) and clears it.
export function StreamingRow({ text, accentColor }) {
    const tokens = useSkin();
    if (!text)
        return null;
    return (_jsxs(Box, { marginBottom: 1, gap: 1, children: [_jsx(Text, { color: accentColor ?? tokens.semantic.success, children: tokens.glyphs.accentStripe }), _jsx(Text, { bold: true, color: tokens.surface.textPrimary, children: "ethos" }), _jsx(Text, { dimColor: true, children: tokens.glyphs.prompt }), _jsx(Text, { wrap: "wrap", children: text })] }));
}
