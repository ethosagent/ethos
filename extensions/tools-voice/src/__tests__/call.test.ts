import type {
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from '@ethosagent/platform-voice';
import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createVoiceTools } from '../index';

// In-memory SIP trunk — `calls` is the assertion surface (empty ⇒ nothing dialed).
class FakeSipTrunkClient implements SipTrunkClient {
  readonly calls: OutboundCallRequest[] = [];
  async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallHandle> {
    this.calls.push(req);
    return { callId: `call-${this.calls.length}`, roomName: req.roomName, toNumber: req.toNumber };
  }
}

function callTool(trunk: SipTrunkClient, fromNumber?: string): Tool {
  const tools = createVoiceTools(fromNumber ? { trunk, fromNumber } : { trunk });
  const tool = tools.find((t) => t.name === 'call');
  if (!tool) throw new Error('call tool not registered');
  return tool;
}

const ctx = { sessionId: 's', sessionKey: 'k', platform: 'voice', workingDir: '/' } as ToolContext;

// Faithful stand-in for AgentLoop's approval gate: a tool marked
// `requiresApproval` is NOT executed unless the approval surface approves it
// (packages/core/.../tool-processing.ts). This mirrors that boundary so the
// "without approval, no call is placed" contract is exercised end to end.
async function runGated(tool: Tool, args: unknown, approved: boolean) {
  if (tool.requiresApproval && !approved) {
    return { ok: false as const, code: 'not_available' as const, error: 'awaiting approval' };
  }
  return tool.execute(args, ctx);
}

describe('call tool — approval gating', () => {
  it('is marked requiresApproval so AgentLoop gates it', () => {
    expect(callTool(new FakeSipTrunkClient()).requiresApproval).toBe(true);
  });

  it('does NOT place the call when approval is denied', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await runGated(callTool(trunk), { to_number: '+15551234567' }, false);

    expect(result.ok).toBe(false);
    expect(trunk.calls).toHaveLength(0);
  });

  it('places the call once approved', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await runGated(callTool(trunk), { to_number: '+15551234567' }, true);

    expect(result.ok).toBe(true);
    expect(trunk.calls).toHaveLength(1);
    expect(trunk.calls[0]?.toNumber).toBe('+15551234567');
  });
});

describe('call tool — execution', () => {
  it('bridges into a default per-call room and passes the trunk fromNumber', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await callTool(trunk, '+15550000000').execute(
      { to_number: '+15551234567' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(trunk.calls[0]).toEqual({
      toNumber: '+15551234567',
      roomName: 'call-15551234567',
      fromNumber: '+15550000000',
    });
  });

  it('honors an explicit room_name', async () => {
    const trunk = new FakeSipTrunkClient();
    await callTool(trunk).execute({ to_number: '+15551234567', room_name: 'vip-room' }, ctx);
    expect(trunk.calls[0]?.roomName).toBe('vip-room');
  });

  it('rejects a non-E.164 number without dialing', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await callTool(trunk).execute({ to_number: '555-1234' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(trunk.calls).toHaveLength(0);
  });

  it('surfaces a trunk failure as execution_failed without throwing', async () => {
    const trunk: SipTrunkClient = {
      createOutboundCall: () => Promise.reject(new Error('trunk down')),
    };
    const result = await callTool(trunk).execute({ to_number: '+15551234567' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('trunk down');
    }
  });
});
