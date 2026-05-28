export const MCP_REMOTE_PRESETS = {
    linear: {
        name: 'linear',
        label: 'Linear',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
    },
};
export function getRemotePreset(name) {
    return MCP_REMOTE_PRESETS[name];
}
