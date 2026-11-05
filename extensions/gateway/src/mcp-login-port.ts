// Gateway-local seam for `/mcp login | code | cancel` (plan mcp-device-code-login §8.2).
//
// The gateway cannot import `extensions/tools-mcp` (`extensions-implement-contracts`
// in architecture.config.ts), so it speaks to the sign-in service through this
// interface. `createMcpLoginPort` in packages/wiring/src/mcp-login.ts builds it
// from a bot's McpManager + McpDeviceLogin/McpPasteLogin; `GatewayConfig.mcpLoginFor`
// and `GatewayBotConfig.mcpLogin` carry it in.

export type McpLoginSettlement = {
  status: 'connected' | 'denied' | 'expired' | 'cancelled' | 'error';
  reason?: string;
};

export type McpLoginStart =
  | {
      kind: 'device';
      flowId: string;
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      serverHost: string;
      authHost: string;
    }
  | {
      kind: 'paste';
      flowId: string;
      authorizeUrl: string;
      serverHost: string;
      authHost: string;
      expiresAt: number;
    }
  | { kind: 'refused'; code: string; detail?: string };

export interface McpLoginPort {
  /** Whether `serverName` is in `personalityId`'s `mcp_servers` (check 6 of §8.3). */
  isAttached(serverName: string, personalityId: string): boolean;
  start(input: { serverName: string; personalityId: string }): Promise<McpLoginStart>;
  completePaste(
    flowId: string,
    pasted: string,
  ): Promise<{ ok: true } | { ok: false; code: string }>;
  onSettled(flowId: string, cb: (s: McpLoginSettlement) => void): void;
  cancel(flowId: string): void;
}
