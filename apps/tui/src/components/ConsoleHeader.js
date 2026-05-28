import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { basename } from 'node:path';
import { Box, Text } from 'ink';
export function ConsoleHeader({ model, personality, sessionKey, accentColor }) {
    const workspace = process.cwd();
    const workspaceName = basename(workspace);
    return (_jsxs(Box, { justifyContent: "space-between", marginBottom: 1, children: [_jsxs(Text, { children: [_jsx(Text, { color: accentColor, children: "\u258C" }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "ethos" }), _jsx(Text, { dimColor: true, children: " \u00B7 model " }), _jsx(Text, { children: model }), _jsx(Text, { dimColor: true, children: " \u00B7 role " }), _jsx(Text, { children: personality })] }), _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "workspace " }), _jsx(Text, { children: workspaceName }), _jsx(Text, { dimColor: true, children: " \u00B7 session " }), _jsx(Text, { children: sessionKey }), _jsx(Text, { dimColor: true, children: " \u00B7 env " }), _jsx(Text, { children: "local" })] })] }));
}
