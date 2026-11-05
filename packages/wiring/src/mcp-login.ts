// createMcpLoginPort — the gateway's `/mcp login` seam, built from one bot's
// McpManager (plan mcp-device-code-login §8.2).
//
// The gateway extension cannot import tools-mcp, and apps reach extensions only
// through wiring, so this is where McpDeviceLogin / McpPasteLogin meet the
// gateway-local `McpLoginPort` interface (extensions/gateway/src/mcp-login-port.ts).
// The shape here is structural and must stay assignable to that interface; the
// assignment is pinned by the type-level check in
// packages/wiring/src/__tests__/mcp-login-port.test.ts.
//
// Device first; `device_unavailable` / `device_refused` fall back to paste
// (plan D3). A device flow and a paste flow share one `LoginSlots`, so a
// (personality, server) grant slot has one pending flow across both kinds —
// pinned by extensions/tools-mcp/src/__tests__/device-login.test.ts.

import {
  type LoginAuditEvent,
  LoginSlots,
  McpDeviceLogin,
  McpJsonStore,
  type McpManager,
  McpPasteLogin,
} from '@ethosagent/tools-mcp';
import type { Logger, SecretsResolver, Storage } from '@ethosagent/types';

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

/** Structurally identical to the gateway's `McpLoginPort`. */
export interface McpLoginPortHandle {
  isAttached(serverName: string, personalityId: string): boolean;
  start(input: { serverName: string; personalityId: string }): Promise<McpLoginStart>;
  completePaste(
    flowId: string,
    pasted: string,
  ): Promise<{ ok: true } | { ok: false; code: string }>;
  onSettled(flowId: string, cb: (s: McpLoginSettlement) => void): void;
  cancel(flowId: string): void;
  /** Abort every pending flow. Idempotent; register it on the bot's DisposerStack. */
  dispose(): void;
}

export interface CreateMcpLoginPortOptions {
  /** The Storage `mcp.json` lives in. Built here so apps never import tools-mcp (`l5-apps-through-wiring`). */
  storage: Storage;
  /** Override for tests; default `~/.ethos/mcp.json`. */
  mcpJsonPath?: string;
  secrets: SecretsResolver;
  /** The bot loop's manager (`CreateAgentLoopResult.mcpManager`): tokens are reconnected on THIS manager only. */
  mcpManager: Pick<McpManager, 'registerConfig' | 'reconnectPersonality'>;
  /** The bot loop's personality registry (`CreateAgentLoopResult.personalities`). */
  personalities: { get(id: string): { mcp_servers?: string[] } | undefined };
  logger?: Logger;
  recordEvent?: (event: LoginAuditEvent) => void;
}

export function createMcpLoginPort(opts: CreateMcpLoginPortOptions): McpLoginPortHandle {
  const slots = new LoginSlots({ logger: opts.logger, recordEvent: opts.recordEvent });
  const deps = {
    mcpJsonStore: new McpJsonStore(opts.storage, opts.mcpJsonPath),
    secrets: opts.secrets,
    mcpManager: opts.mcpManager,
    logger: opts.logger,
    recordEvent: opts.recordEvent,
    slots,
  };
  const device = new McpDeviceLogin(deps);
  const paste = new McpPasteLogin(deps);

  async function startPaste(serverName: string, personalityId: string): Promise<McpLoginStart> {
    const r = await paste.start({ serverName, personalityId, surface: 'gateway' });
    if (!r.ok) return { kind: 'refused', code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
    return {
      kind: 'paste',
      flowId: r.flowId,
      authorizeUrl: r.authorizeUrl,
      serverHost: r.serverHost,
      authHost: r.authHost,
      expiresAt: r.expiresAt,
    };
  }

  return {
    isAttached: (serverName, personalityId) =>
      opts.personalities.get(personalityId)?.mcp_servers?.includes(serverName) ?? false,

    async start({ serverName, personalityId }) {
      const d = await device.start({ serverName, personalityId, surface: 'gateway' });
      if (d.ok) {
        // `verificationUriComplete` is deliberately dropped: chat gets the plain URI (plan D13).
        return {
          kind: 'device',
          flowId: d.flowId,
          userCode: d.userCode,
          verificationUri: d.verificationUri,
          expiresAt: d.expiresAt,
          serverHost: d.serverHost,
          authHost: d.authHost,
        };
      }
      if (d.code === 'device_unavailable' || d.code === 'device_refused') {
        return startPaste(serverName, personalityId);
      }
      return { kind: 'refused', code: d.code, ...(d.detail ? { detail: d.detail } : {}) };
    },

    async completePaste(flowId, pasted) {
      const r = await paste.complete(flowId, pasted);
      return r.ok ? { ok: true } : { ok: false, code: r.code };
    },

    // One shared `LoginSlots`: either class settles any flow.
    onSettled: (flowId, cb) => slots.onSettled(flowId, cb),
    cancel: (flowId) => slots.cancel(flowId),
    dispose: () => {
      device.dispose();
      paste.dispose();
    },
  };
}
