// `ethos gateway start` registers the unattended approval gate on its
// systemLoop (openclaw-advisory-fixes Item 3). Before this, `wireApprovalFlow`
// was the only `before_tool_call` approval registration in the command and it
// only ever received bot loops, so cron, dreams and SIP-inbound turns ran
// flagged tools unattended.
//
// Two halves, the same idiom as `gateway-observability-wiring.test.ts`:
//  - runtime: `wireUnattendedApprovalGate` registers exactly one modifying
//    `before_tool_call` handler on the registry it is handed, and it refuses;
//  - source text: `runGatewayStart` hands it the systemLoop's hooks, before
//    the cron scheduler starts, with the gateway's channel-turn route as its
//    remote-sender test. `runGatewayStart` boots a whole process and
//    cannot be invoked from a unit test.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefaultPersonalityRegistry } from '@ethosagent/core';
import type { BeforeToolCallPayload, HookRegistry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { wireUnattendedApprovalGate } from '../../unattended-approval-gate';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

describe('gateway systemLoop — unattended approval gate wiring', () => {
  it('registers one before_tool_call modifying handler that refuses a flagged call', async () => {
    const handlers: Array<(p: BeforeToolCallPayload) => Promise<unknown>> = [];
    const registerModifying = vi.fn((name: string, handler: never) => {
      if (name === 'before_tool_call') handlers.push(handler);
      return () => {};
    });
    const hooks = {
      registerModifying,
      registerVoid: vi.fn(() => () => {}),
    } as unknown as HookRegistry;

    wireUnattendedApprovalGate(hooks, {
      personalities: new DefaultPersonalityRegistry(),
      getProvider: async () => {
        throw new Error('the smart reviewer must not be constructed');
      },
      model: 'm',
      allowUnattendedDangerousTools: false,
      isRemoteSenderTurn: () => false,
    });

    expect(registerModifying).toHaveBeenCalledTimes(1);
    expect(registerModifying).toHaveBeenCalledWith('before_tool_call', expect.any(Function));
    const [handler] = handlers;
    expect(
      await handler?.({ sessionId: 's', toolCallId: 't', toolName: 'call', args: {} }),
    ).toEqual({ error: 'no human is present to approve call (call requires explicit approval)' });
  });

  it('runGatewayStart registers it on the systemLoop, before cron starts', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    const assigned = src.indexOf('systemLoop = systemLoopReady;');
    const wired = src.indexOf('wireUnattendedApprovalGate(systemLoopReady.hooks, {');
    const cronStart = src.indexOf('cronTriggers.local?.start();');
    expect(assigned).toBeGreaterThan(-1);
    expect(wired).toBeGreaterThan(assigned);
    expect(cronStart).toBeGreaterThan(wired);
    // The operator key is the only thing that can loosen it.
    const call = src.slice(wired, src.indexOf('});', wired));
    expect(call).toContain(
      'allowUnattendedDangerousTools: config.allowUnattendedDangerousTools === true',
    );
    // A remote-sender (idle gateway channel) turn is told apart by the route
    // the gateway holds for its own channel turns, never by the opt-in.
    expect(call).toContain(
      'isRemoteSenderTurn: (sessionId) => gatewayRef?.resolveApprovalRoute(sessionId) !== undefined',
    );
    // And the boot-time exposure warning runs beside it.
    expect(src.indexOf('reportUnattendedCronExposure({')).toBeGreaterThan(wired);
  });

  it('ethos boot: the idle bot shares the web loop, which never takes the D12 opt-in', async () => {
    const boot = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    const serve = await readFile(join(ROOT, 'apps/ethos/src/commands/serve.ts'), 'utf8');
    // No unattended gate, and no opt-in threaded anywhere in boot…
    expect(boot).not.toContain('wireUnattendedApprovalGate(');
    expect(boot).not.toContain('allowAutoApproveDangerousTools');
    expect(boot).not.toMatch(/allowUnattendedDangerousTools:/);
    // …and the web approval hook's predicate is built without it.
    const start = serve.indexOf('export function buildServeDangerPredicate(');
    expect(start).toBeGreaterThan(-1);
    const body = serve.slice(start, serve.indexOf('\n}\n', start));
    expect(body).toContain('createApprovalDangerPredicate({');
    expect(body).not.toContain('allowAutoApproveDangerousTools');
  });
});
