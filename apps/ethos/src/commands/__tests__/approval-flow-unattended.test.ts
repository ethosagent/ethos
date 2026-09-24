// `wireApprovalFlow` gives every bot loop exactly one approval gate
// (openclaw-advisory-fixes §0 constraint 2, "fail closed where no human is
// present"). Before this, a bot with no approval-capable adapter (WhatsApp,
// Email, a webhook route bot) got no `before_tool_call` approval hook at all,
// and a turn on a card-capable bot's loop that arrived through a card-less
// adapter passed straight through — both ran approval-flagged tools unattended.
//
// Two halves, the same idiom as `gateway-unattended-gate-wiring.test.ts`:
//  - runtime: the real `wireApprovalFlow` with stub adapters and a stub route;
//  - source text: every host that wires bot loops goes through it with the
//    D12 operator key. Neither host boots from a unit test.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type {
  BeforeToolCallPayload,
  BeforeToolCallResult,
  PersonalityConfig,
  PersonalityRegistry,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { wireApprovalFlow } from '../gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  // The coordinator's audit sink opens the process-wide observability store
  // lazily — keep it off the developer's real ~/.ethos.
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-approval-unattended-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const PERSONALITIES: Record<string, PersonalityConfig> = {
  manual: { id: 'manual', name: 'manual' } as PersonalityConfig,
  auto: { id: 'auto', name: 'auto', safety: { approvalMode: 'off' } } as PersonalityConfig,
};

/** A WhatsApp/Email-shaped adapter: no `postApprovalCard`. */
function cardlessAdapter(botKey: string): PlatformAdapter {
  return { id: `whatsapp:${botKey}`, botKey } as unknown as PlatformAdapter;
}

/** A Telegram-shaped adapter that can post approval cards. */
function cardAdapter(botKey: string) {
  const posted: string[] = [];
  const adapter = {
    id: `telegram:${botKey}`,
    botKey,
    postApprovalCard: async (card: { approvalId: string }) => {
      posted.push(card.approvalId);
      return { messageTs: 'ts-1' };
    },
    updateApprovalCard: async () => ({ ok: true }),
    onApprovalDecision: () => {},
  } as unknown as PlatformAdapter;
  return { adapter, posted };
}

function bot(botKey: string) {
  const hooks = new DefaultHookRegistry();
  const register = vi.spyOn(hooks, 'registerModifying');
  const config = {
    botKey,
    loop: { hooks },
    binding: { type: 'personality', name: 'manual' },
  } as unknown as GatewayBotConfig;
  const beforeToolCallHandlers = () =>
    register.mock.calls.filter(([name]) => name === 'before_tool_call').length;
  return { config, hooks, beforeToolCallHandlers };
}

function wire(opts: {
  bots: GatewayBotConfig[];
  adapters: PlatformAdapter[];
  routeAdapter?: PlatformAdapter;
  allowUnattendedDangerousTools?: boolean;
}) {
  const gateway = {
    resolveApprovalRoute: () =>
      opts.routeAdapter
        ? {
            adapter: opts.routeAdapter,
            chatId: 'C1',
            requesterUserId: 'U1',
            isDm: true,
            platform: 'telegram',
          }
        : undefined,
  } as unknown as Gateway;
  return wireApprovalFlow(gateway, opts.bots, opts.adapters, {
    personalities: { get: (id: string) => PERSONALITIES[id] } as unknown as PersonalityRegistry,
    getProvider: async () => {
      throw new Error('the smart reviewer must not be constructed');
    },
    model: 'test-model',
    approvalTimeoutMs: 0,
    ownerFor: () => undefined,
    allowUnattendedDangerousTools: opts.allowUnattendedDangerousTools === true,
  });
}

async function startTurn(hooks: DefaultHookRegistry, personalityId: string): Promise<void> {
  await hooks.fireVoid('session_start', {
    sessionId: 'sid-1',
    sessionKey: 'whatsapp:bot:chat',
    platform: 'whatsapp',
    personalityId,
  });
}

function callTool(
  hooks: DefaultHookRegistry,
  toolName: string,
): Promise<Partial<BeforeToolCallResult>> {
  return hooks.fireModifying('before_tool_call', {
    sessionId: 'sid-1',
    toolCallId: 'tc-1',
    toolName,
    args: {},
  } satisfies BeforeToolCallPayload);
}

const REFUSED_CALL = 'no human is present to approve call (call requires explicit approval)';

describe('wireApprovalFlow — bot loops with no approval surface', () => {
  it('a WhatsApp-like bot refuses a flagged tool and runs an unflagged one', async () => {
    const b = bot('wa');
    const flow = wire({ bots: [b.config], adapters: [cardlessAdapter('wa')] });
    await startTurn(b.hooks, 'manual');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
    expect((await callTool(b.hooks, 'read_file')).error).toBeUndefined();
    expect(b.beforeToolCallHandlers()).toBe(1);
    await flow.shutdown();
  });

  it('a bot with no adapter at all (webhook route bot) is gated too', async () => {
    const b = bot('hook');
    const flow = wire({ bots: [b.config], adapters: [] });
    await startTurn(b.hooks, 'manual');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
    expect(b.beforeToolCallHandlers()).toBe(1);
    await flow.shutdown();
  });

  it('D12: approvalMode off + allowUnattendedDangerousTools lets the flagged call through', async () => {
    const b = bot('wa');
    const flow = wire({
      bots: [b.config],
      adapters: [cardlessAdapter('wa')],
      allowUnattendedDangerousTools: true,
    });
    await startTurn(b.hooks, 'auto');

    expect((await callTool(b.hooks, 'call')).error).toBeUndefined();
    await flow.shutdown();
  });

  it('D12 needs both halves: approvalMode off alone still refuses', async () => {
    const b = bot('wa');
    const flow = wire({ bots: [b.config], adapters: [cardlessAdapter('wa')] });
    await startTurn(b.hooks, 'auto');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
    await flow.shutdown();
  });

  it('a Telegram bot keeps the card flow, with exactly one gate', async () => {
    const b = bot('tg');
    const { adapter, posted } = cardAdapter('tg');
    const flow = wire({ bots: [b.config], adapters: [adapter], routeAdapter: adapter });
    await startTurn(b.hooks, 'manual');

    const result = callTool(b.hooks, 'call');
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(b.beforeToolCallHandlers()).toBe(1);
    // Shutdown force-denies the pending approval: the card flow owned it.
    await flow.shutdown();
    expect((await result).error).toMatch(/call requires explicit approval/);
    expect((await result).error).not.toMatch(/no human is present/);
  });

  it('mixed bot: a turn through its card-less adapter is refused, not allowed', async () => {
    const b = bot('mixed');
    const { adapter, posted } = cardAdapter('mixed');
    const email = cardlessAdapter('mixed');
    const flow = wire({ bots: [b.config], adapters: [adapter, email], routeAdapter: email });
    await startTurn(b.hooks, 'manual');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
    expect((await callTool(b.hooks, 'read_file')).error).toBeUndefined();
    expect(posted).toHaveLength(0);
    expect(b.beforeToolCallHandlers()).toBe(1);
    await flow.shutdown();
  });

  it('mixed bot: the D12 opt-in applies on the card-less turn too', async () => {
    const b = bot('mixed');
    const { adapter } = cardAdapter('mixed');
    const email = cardlessAdapter('mixed');
    const flow = wire({
      bots: [b.config],
      adapters: [adapter, email],
      routeAdapter: email,
      allowUnattendedDangerousTools: true,
    });
    await startTurn(b.hooks, 'auto');

    expect((await callTool(b.hooks, 'call')).error).toBeUndefined();
    await flow.shutdown();
  });

  it('one call covers a card bot and a card-less bot side by side, one gate each', async () => {
    const tg = bot('tg');
    const wa = bot('wa');
    const { adapter } = cardAdapter('tg');
    const flow = wire({
      bots: [tg.config, wa.config],
      adapters: [adapter, cardlessAdapter('wa')],
      routeAdapter: adapter,
    });
    await startTurn(wa.hooks, 'manual');

    expect((await callTool(wa.hooks, 'call')).error).toBe(REFUSED_CALL);
    expect(tg.beforeToolCallHandlers()).toBe(1);
    expect(wa.beforeToolCallHandlers()).toBe(1);
    await flow.shutdown();
  });
});

describe('every bot-loop host goes through wireApprovalFlow with the D12 key', () => {
  it('ethos gateway start: one call over all bots, with the operator key', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    const call = src.indexOf('wireApprovalFlow(gateway, bots, adapters, {');
    expect(call).toBeGreaterThan(-1);
    expect(src.slice(call, src.indexOf('});', call))).toContain(
      'allowUnattendedDangerousTools: config.allowUnattendedDangerousTools === true',
    );
    // The bot-loop unattended gate lives inside `wireApprovalFlow` only: the
    // command's one direct registration is the systemLoop's.
    const direct = [...src.matchAll(/wireUnattendedApprovalGate\((\w+(?:\.\w+)*)/g)].map(
      (m) => m[1],
    );
    expect(direct).toEqual(['systemLoopReady.hooks', 'bot.loop.hooks']);
    const fn = src.indexOf('export function wireApprovalFlow(');
    expect(src.indexOf('wireUnattendedApprovalGate(bot.loop.hooks')).toBeGreaterThan(fn);
    // ...and before the no-approval-adapter early return.
    expect(src.indexOf('if (approvalAdapters.length === 0) return')).toBeGreaterThan(
      src.indexOf('wireUnattendedApprovalGate(bot.loop.hooks'),
    );
  });

  it('ethos boot: cold boot, hot-add, webhook bots and replacements all use registerBotLive', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    const seams = src.indexOf('const approvalSeams = {');
    expect(src.slice(seams, src.indexOf('};', seams))).toContain(
      'allowUnattendedDangerousTools: cfg.allowUnattendedDangerousTools === true',
    );
    const registerLive = src.indexOf('const registerBotLive = async (');
    const flowCall = src.indexOf('wireApprovalFlow(gateway, [bot], adaptersSlice, approvalSeams)');
    expect(flowCall).toBeGreaterThan(registerLive);
    // The only call in the file: nothing wires a bot loop around it.
    expect(src.split('wireApprovalFlow(gateway').length - 1).toBe(1);
    expect(src).not.toContain('wireUnattendedApprovalGate(');
    // Cold boot, live channel-bot hot-add (also the replacement path), webhook route bot.
    expect(src).toContain('await registerBotLive(bot, wiring, own ? [own] : [])');
    expect(src).toContain('wire: () => registerBotLive(bot, wiring, [adapter])');
    expect(src).toContain('wire: () => registerBotLive(prepared.bot, prepared.wiring, [])');
  });
});
