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

function voiceSessionTool(): Tool {
  const tool = createVoiceTools().find((t) => t.name === 'voice_session');
  if (!tool) throw new Error('voice_session tool not registered');
  return tool;
}

describe('voice_session capability tool', () => {
  it('is exported from the factory even with no trunk configured', () => {
    const names = createVoiceTools().map((t) => t.name);
    expect(names).toContain('voice_session');
  });

  it('is grouped under the voice toolset', () => {
    expect(voiceSessionTool().toolset).toBe('voice');
  });

  it('is ALWAYS available regardless of live infra (it is a selectable gate)', () => {
    expect(voiceSessionTool().isAvailable?.()).toBe(true);
    // Even with a trunk wired, the capability marker stays available.
    const withTrunk = createVoiceTools({ trunk: new FakeSipTrunkClient() }).find(
      (t) => t.name === 'voice_session',
    );
    expect(withTrunk?.isAvailable?.()).toBe(true);
  });

  it('does not require approval — it is not a live action', () => {
    expect(voiceSessionTool().requiresApproval).toBeFalsy();
  });

  it('a stray model call is harmless and explains the session is channel-managed', async () => {
    const result = await voiceSessionTool().execute({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/channel|managed/i);
  });
});

describe('call tool — availability gating', () => {
  it('reports unavailable when no trunk is configured', () => {
    const tool = createVoiceTools().find((t) => t.name === 'call');
    expect(tool?.isAvailable?.()).toBe(false);
  });

  it('reports available once a trunk is configured', () => {
    expect(callTool(new FakeSipTrunkClient()).isAvailable?.()).toBe(true);
  });

  it('refuses to dial with not_available when executed without a trunk', async () => {
    const tool = createVoiceTools().find((t) => t.name === 'call');
    const result = await tool?.execute({ to_number: '+15551234567' }, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('not_available');
  });
});

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
