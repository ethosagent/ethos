import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { DeliveryResult, InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway, type GatewayBotConfig } from '../index';
import type { McpLoginPort, McpLoginSettlement, McpLoginStart } from '../mcp-login-port';

// `/mcp login | code | cancel` (plan mcp-device-code-login §8.3): owner-only,
// DM-only, private-audience-only, checked before port.start, answered before
// the agent, and every reply an untracked dedup-gated send.

const DEVICE: McpLoginStart = {
  kind: 'device',
  flowId: 'flow-1',
  userCode: 'ABCD-EFGHJ',
  verificationUri: 'https://mcp-auth.granola.ai/device',
  expiresAt: Date.now() + 5 * 60_000,
  serverHost: 'mcp.granola.ai',
  authHost: 'mcp-auth.granola.ai',
};

class FakePort implements McpLoginPort {
  attached = new Set(['granola']);
  next: McpLoginStart = DEVICE;
  startCalls: { serverName: string; personalityId: string }[] = [];
  pasted: { flowId: string; text: string }[] = [];
  pasteResult: { ok: true } | { ok: false; code: string } = { ok: true };
  cancelled: string[] = [];
  listeners = new Map<string, (s: McpLoginSettlement) => void>();
  isAttached(serverName: string): boolean {
    return this.attached.has(serverName);
  }
  async start(input: { serverName: string; personalityId: string }): Promise<McpLoginStart> {
    this.startCalls.push(input);
    return this.next;
  }
  async completePaste(flowId: string, text: string) {
    this.pasted.push({ flowId, text });
    return this.pasteResult;
  }
  onSettled(flowId: string, cb: (s: McpLoginSettlement) => void): void {
    this.listeners.set(flowId, cb);
  }
  cancel(flowId: string): void {
    this.cancelled.push(flowId);
    this.listeners.get(flowId)?.({ status: 'cancelled' });
  }
  settle(flowId: string, s: McpLoginSettlement): void {
    this.listeners.get(flowId)?.(s);
  }
}

function makeAdapter(): PlatformAdapter & {
  sent: { chatId: string; text: string; threadId?: string }[];
} {
  const sent: { chatId: string; text: string; threadId?: string }[] = [];
  return {
    id: 'telegram:bot-1',
    displayName: 'Telegram',
    capabilities: { platform: 'test' },
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(chatId: string, msg: { text: string; threadId?: string }): Promise<DeliveryResult> {
      sent.push({ chatId, text: msg.text, threadId: msg.threadId });
      return { ok: true, messageId: `m${sent.length}` };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
    sent,
  };
}

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botKey: 'bot-1',
    chatId: 'D1',
    userId: 'owner',
    text,
    isDm: true,
    isGroupMention: false,
    messageId: `msg-${Math.random()}`,
    raw: null,
    ...overrides,
  };
}

function setup(
  opts: {
    owner?: string | null;
    port?: FakePort | null;
    binding?: GatewayBotConfig['binding'];
    platform?: string;
  } = {},
) {
  const run = vi.fn(async function* () {
    yield { type: 'done' as const, text: 'agent reply', turnCount: 1 };
  });
  const loop = { hooks: new DefaultHookRegistry(), run } as unknown as AgentLoop;
  const port = opts.port === null ? undefined : (opts.port ?? new FakePort());
  const platform = opts.platform ?? 'telegram';
  const gw = new Gateway({
    bots: [
      {
        botKey: 'bot-1',
        loop,
        binding: opts.binding ?? { type: 'personality', name: 'researcher' },
      },
    ],
    clarifySweepIntervalMs: 0,
    ...(opts.owner === null
      ? {}
      : {
          channelFilter: {
            [platform]: {
              ownerUserId: opts.owner ?? 'owner',
              recipientAllowlist: ['owner', 'stranger'],
            },
          },
        }),
    ...(port ? { mcpLoginFor: (k: string) => (k === 'bot-1' ? port : undefined) } : {}),
  });
  return { gw, run, port, adapter: makeAdapter() };
}

describe('gateway /mcp login', () => {
  it('a non-owner DM is refused and port.start is not called', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola', { userId: 'stranger' }), adapter);
    expect(adapter.sent.at(-1)?.text).toBe('Only the owner may sign in to MCP servers.');
    expect(port?.startCalls).toEqual([]);
  });

  it('a group message from the owner is refused and port.start is not called', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(
      inbound('/mcp login granola', { chatId: 'G1', isDm: false, isGroupMention: true }),
      adapter,
    );
    expect(adapter.sent.at(-1)?.text).toBe('Send /mcp login to me in a direct message.');
    expect(port?.startCalls).toEqual([]);
  });

  it('an owner DM with audienceHint shared is refused', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola', { audienceHint: 'shared' }), adapter);
    expect(adapter.sent.at(-1)?.text).toBe('Send /mcp login to me in a direct message.');
    expect(port?.startCalls).toEqual([]);
  });

  it('no ownerUserId configured is refused with the config hint', async () => {
    const { gw, port, adapter } = setup({ owner: null });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    expect(adapter.sent.at(-1)?.text).toBe(
      'Set channel_filter.telegram.ownerUserId in config.yaml.',
    );
    expect(port?.startCalls).toEqual([]);
  });

  it('a gateway without a port says sign-in is not available', async () => {
    const { gw, adapter } = setup({ port: null });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    expect(adapter.sent.at(-1)?.text).toBe('MCP sign-in is not available on this gateway.');
  });

  it('a team bot is refused', async () => {
    const { gw, port, adapter } = setup({ binding: { type: 'team', name: 'crew' } });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    expect(adapter.sent.at(-1)?.text).toBe('Sign in from the CLI for team bots.');
    expect(port?.startCalls).toEqual([]);
  });

  it('a server not attached to the lane personality is refused', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login linear'), adapter);
    expect(adapter.sent.at(-1)?.text).toBe(
      "'linear' is not attached to researcher. Attach it first: ethos personality mcp researcher --attach linear.",
    );
    expect(port?.startCalls).toEqual([]);
  });

  it('a device start sends one message naming server host, auth host and personality, without verification_uri_complete', async () => {
    const port = new FakePort();
    port.next = {
      ...DEVICE,
      verificationUriComplete: 'https://mcp-auth.granola.ai/device?user_code=ABCD-EFGHJ',
    } as McpLoginStart;
    const { gw, adapter } = setup({ port });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    expect(port.startCalls).toEqual([{ serverName: 'granola', personalityId: 'researcher' }]);
    expect(adapter.sent).toHaveLength(1);
    const text = adapter.sent[0]?.text ?? '';
    expect(text).toContain('Sign in to granola for personality "researcher"');
    expect(text).toContain('Server: mcp.granola.ai · Authorization: mcp-auth.granola.ai');
    expect(text).toContain('Open https://mcp-auth.granola.ai/device and enter ABCD-EFGHJ');
    expect(text).toContain(
      'Expires in 5 min. If you did not just send /mcp login, ignore this message.',
    );
    expect(text).not.toContain('user_code=');
  });

  it('a paste start carries the authorize URL and the /mcp code instruction', async () => {
    const port = new FakePort();
    port.next = {
      kind: 'paste',
      flowId: 'flow-p',
      authorizeUrl: 'https://auth.example.com/authorize?x=1',
      serverHost: 'mcp.example.com',
      authHost: 'auth.example.com',
      expiresAt: Date.now() + 10 * 60_000,
    };
    const { gw, adapter } = setup({ port });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    const text = adapter.sent[0]?.text ?? '';
    expect(text).toContain('https://auth.example.com/authorize?x=1');
    expect(text).toContain('Then send: /mcp code <the address your browser ended on>');
    expect(text).toContain('Server: mcp.example.com · Authorization: auth.example.com');
  });

  it('a refused start names the code', async () => {
    const port = new FakePort();
    port.next = { kind: 'refused', code: 'already_pending' };
    const { gw, adapter } = setup({ port });
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    expect(adapter.sent.at(-1)?.text).toContain('already_pending');
  });

  it('settlement replies once in the originating lane', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola', { threadId: 'T1' }), adapter);
    const before = adapter.sent.length;
    port?.settle('flow-1', { status: 'connected' });
    port?.settle('flow-1', { status: 'connected' });
    await vi.waitFor(() => expect(adapter.sent.length).toBe(before + 1));
    expect(adapter.sent.at(-1)).toEqual({
      chatId: 'D1',
      text: '✓ Signed in to granola for researcher.',
      threadId: 'T1',
    });
  });

  it('a second /mcp login in the same lane is refused and does not start a flow', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    port?.attached.add('other');
    await gw.handleMessage(inbound('/mcp login other'), adapter);
    expect(adapter.sent.at(-1)?.text).toBe('A sign-in is already waiting. Send /mcp cancel first.');
    expect(port?.startCalls).toHaveLength(1);
  });

  it('/mcp code passes the text to completePaste and never echoes it', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    const before = adapter.sent.length;
    const secretUrl = 'http://127.0.0.1:43210/oauth/callback?code=SECRETCODE&state=SECRETSTATE';
    await gw.handleMessage(inbound(`/mcp code ${secretUrl}`), adapter);
    expect(port?.pasted).toEqual([{ flowId: 'flow-1', text: secretUrl }]);
    expect(adapter.sent).toHaveLength(before);

    if (port) port.pasteResult = { ok: false, code: 'invalid_paste' };
    await gw.handleMessage(inbound(`/mcp code ${secretUrl}`), adapter);
    const reply = adapter.sent.at(-1)?.text ?? '';
    expect(reply).toContain('invalid_paste');
    expect(reply).not.toContain('SECRET');
  });

  it('/mcp cancel cancels the lane flow and /mcp code without a flow says so', async () => {
    const { gw, port, adapter } = setup();
    await gw.handleMessage(inbound('/mcp code http://127.0.0.1:1/x'), adapter);
    expect(adapter.sent.at(-1)?.text).toContain('No sign-in is waiting');
    expect(port?.pasted).toEqual([]);

    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    await gw.handleMessage(inbound('/mcp cancel'), adapter);
    expect(port?.cancelled).toEqual(['flow-1']);
    await vi.waitFor(() => expect(adapter.sent.at(-1)?.text).toBe('✗ Sign-in cancelled.'));
  });

  it('/mcp messages never reach the AgentLoop', async () => {
    const { gw, run, adapter } = setup();
    await gw.handleMessage(inbound('/mcp login granola'), adapter);
    await gw.handleMessage(inbound('/mcp code http://127.0.0.1:1/x'), adapter);
    await gw.handleMessage(inbound('/mcp cancel'), adapter);
    await gw.handleMessage(inbound('/mcp login granola', { userId: 'stranger' }), adapter);
    await gw.handleMessage(inbound('/mcp'), adapter);
    expect(run).not.toHaveBeenCalled();
  });

  it('the WhatsApp LID owner matches', async () => {
    const { gw, port, adapter } = setup({
      owner: '15550000000@s.whatsapp.net',
      platform: 'whatsapp',
    });
    await gw.handleMessage(
      inbound('/mcp login granola', {
        platform: 'whatsapp',
        userId: '111@lid',
        alternateUserIds: ['15550000000@s.whatsapp.net'],
      }),
      adapter,
    );
    expect(port?.startCalls).toHaveLength(1);
  });
});
