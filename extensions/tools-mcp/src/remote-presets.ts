export interface McpRemotePreset {
  name: string;
  label: string;
  url: string;
  transport: 'streamable-http';
}

export const MCP_REMOTE_PRESETS: Record<string, McpRemotePreset> = {
  linear: {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
  },
};

export function getRemotePreset(name: string): McpRemotePreset | undefined {
  return MCP_REMOTE_PRESETS[name];
}
