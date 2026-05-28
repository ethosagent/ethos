import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from 'ink';
export const SLASH_COMMANDS = [
    { name: 'help', desc: 'Show all commands' },
    { name: 'new', desc: 'Start a fresh session' },
    { name: 'personality', desc: 'List or switch personality' },
    { name: 'model', desc: 'Open model picker' },
    { name: 'sessions', desc: 'Open session picker' },
    { name: 'memory', desc: 'Show memory content' },
    { name: 'usage', desc: 'Token and cost stats' },
    { name: 'details', desc: 'Toggle section visibility' },
    { name: 'skin', desc: 'Switch UI theme' },
    { name: 'exit', desc: 'Quit' },
];
export function getMatches(input) {
    if (!input.startsWith('/'))
        return [];
    const prefix = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}
export function CompletionPanel({ matches, selectedIndex }) {
    if (matches.length === 0)
        return null;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "single", borderDimColor: true, paddingX: 1, children: [matches.map((cmd, i) => (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: i === selectedIndex ? 'cyan' : undefined, bold: i === selectedIndex, children: ["/", cmd.name] }), _jsxs(Text, { dimColor: true, children: ["\u2014 ", cmd.desc] })] }, cmd.name))), _jsx(Text, { dimColor: true, children: "\u2191/\u2193 navigate \u00B7 Tab/Enter select \u00B7 Esc dismiss" })] }));
}
