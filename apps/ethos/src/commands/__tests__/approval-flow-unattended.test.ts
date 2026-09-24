// `wireApprovalFlow` gives every bot loop exactly one approval gate
// (openclaw-advisory-fixes §0 constraint 2, "fail closed where no human is
// present"). Before this, a bot with no approval-capable adapter (WhatsApp,
// Email, a webhook route bot) got no `before_tool_call` approval hook at all,
// and a turn on a card-capable bot's loop that arrived through a card-less
// adapter passed straight through — both ran approval-flagged tools unattended.
//
// A remote sender drives every one of these turns, so the gate ALWAYS refuses a
// flagged call: the systemLoop's D12 opt-in (`approvalMode: off` +
// `allowUnattendedDangerousTools`) is never honoured on a bot loop.
//
// Two halves, the same idiom as `gateway-unattended-gate-wiring.test.ts`:
//  - runtime: the real `wireApprovalFlow` with stub adapters and a stub route;
//  - source text: every host that wires bot loops goes through it, and the
//    D12 operator key reaches none of it. Neither host boots from a unit test.

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
  /** Smuggle the operator key in as an extra seam, to prove it is ignored. */
  withOperatorKey?: boolean;
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
    ...((opts.withOperatorKey ? { allowUnattendedDangerousTools: true } : {}) as object),
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

const REFUSED_CALL =
  'call needs approval, and this chat surface cannot show an approval prompt ' +
  '(call requires explicit approval). Use a platform with approval cards ' +
  '(Slack, Telegram, Discord) or the web UI.';

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

  it('no D12 on a bot loop: approvalMode off + the operator key still refuses', async () => {
    const b = bot('wa');
    const flow = wire({
      bots: [b.config],
      adapters: [cardlessAdapter('wa')],
      withOperatorKey: true,
    });
    await startTurn(b.hooks, 'auto');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
    await flow.shutdown();
  });

  it('approvalMode off alone also refuses', async () => {
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
    expect((await result).error).not.toMatch(/cannot show an approval prompt/);
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

  it('mixed bot: approvalMode off + the operator key still refuses the card-less turn', async () => {
    const b = bot('mixed');
    const { adapter } = cardAdapter('mixed');
    const email = cardlessAdapter('mixed');
    const flow = wire({
      bots: [b.config],
      adapters: [adapter, email],
      routeAdapter: email,
      withOperatorKey: true,
    });
    await startTurn(b.hooks, 'auto');

    expect((await callTool(b.hooks, 'call')).error).toBe(REFUSED_CALL);
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

describe('every bot-loop host goes through wireApprovalFlow, without the D12 key', () => {
  it('ethos gateway start: one call over all bots; the operator key reaches only the systemLoop', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    const call = src.indexOf('wireApprovalFlow(gateway, bots, adapters, {');
    expect(call).toBeGreaterThan(-1);
    expect(src.slice(call, src.indexOf('});', call))).not.toContain(
      'allowUnattendedDangerousTools',
    );
    // The systemLoop's gate is the command's one `wireUnattendedApprovalGate`.
    expect(src.split('wireUnattendedApprovalGate(').length - 1).toBe(1);
    expect(src).toContain('wireUnattendedApprovalGate(systemLoopReady.hooks, {');
    // Inside `wireApprovalFlow`: the no-surface gate, before the early return,
    // and no operator key anywhere in the function.
    const fn = src.indexOf('export function wireApprovalFlow(');
    const fnBody = src.slice(fn, src.indexOf('\n}\n', fn));
    expect(fnBody).not.toContain('allowUnattendedDangerousTools');
    expect(fnBody).not.toContain('allowAutoApproveDangerousTools');
    const perBot = fnBody.indexOf('createNoApprovalSurfaceGate([bot.loop.hooks]');
    expect(perBot).toBeGreaterThan(-1);
    expect(fnBody.indexOf('if (approvalAdapters.length === 0) return')).toBeGreaterThan(perBot);
  });

  it('the no-surface gate never forwards the auto-approve capability', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/unattended-approval-gate.ts'), 'utf8');
    const fn = src.indexOf('export function createNoApprovalSurfaceGate(');
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn, src.indexOf('\n}\n', fn));
    expect(body).not.toContain('allowAutoApproveDangerousTools');
    expect(body).toContain('noApprovalSurfaceRejection');
  });

  it('ethos boot: cold boot, hot-add, webhook bots and replacements all use registerBotLive', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    const seams = src.indexOf('const approvalSeams = {');
    expect(src.slice(seams, src.indexOf('};', seams))).not.toContain(
      'allowUnattendedDangerousTools',
    );
    const registerLive = src.indexOf('const registerBotLive = async (');
    const flowCall = src.indexOf('wireApprovalFlow(gateway, [bot], adaptersSlice, approvalSeams)');
    expect(flowCall).toBeGreaterThan(registerLive);
    // The only call in the file: nothing wires a bot loop around it.
    expect(src.split('wireApprovalFlow(gateway').length - 1).toBe(1);
    expect(src).not.toContain('wireUnattendedApprovalGate(');
    expect(src).not.toContain('createNoApprovalSurfaceGate(');
    // Cold boot, live channel-bot hot-add (also the replacement path), webhook route bot.
    expect(src).toContain('await registerBotLive(bot, wiring, own ? [own] : [])');
    expect(src).toContain('wire: () => registerBotLive(bot, wiring, [adapter])');
    expect(src).toContain('wire: () => registerBotLive(prepared.bot, prepared.wiring, [])');
  });
});
