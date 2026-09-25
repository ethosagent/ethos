// The smart approver's decision site reaches the gateway's and boot's shared
// approval predicates (plan/phases/decision-provider-jev.md §8.2, M4). Those
// hosts build one loop per bot but share one approval predicate, and
// `decisions.*` is operator-level, so the predicate takes ONE build's
// `approverDecision` — the default-config build (`ethos gateway`'s systemLoop,
// `ethos boot`'s shared loop) — the same way it already takes the operator's
// `createLLM(config)` / `config.model` for the LLM reviewer.
//
// Two halves, the idiom of `approval-flow-unattended.test.ts`:
//  - runtime: `wireApprovalFlow`, `wireUnattendedApprovalGate` and
//    `createNoApprovalSurfaceGate` forward a `decision` to every predicate they
//    build, and pass NO `decision` key when given none (R7: no decisions config
//    → today's predicate options exactly);
//  - source text: the hosts hand those seams the right build's site. Neither
//    host boots from a unit test.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type { PersonalityRegistry, PlatformAdapter } from '@ethosagent/types';
import { createApprovalDangerPredicate, type SmartApproverDecisionSite } from '@ethosagent/wiring';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNoApprovalSurfaceGate,
  wireUnattendedApprovalGate,
} from '../../unattended-approval-gate';
import { wireApprovalFlow } from '../gateway';

vi.mock('@ethosagent/wiring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/wiring')>();
  return {
    ...actual,
    createApprovalDangerPredicate: vi.fn(actual.createApprovalDangerPredicate),
  };
});

const predicateFactory = vi.mocked(createApprovalDangerPredicate);

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  // The coordinator's audit sink opens the observability store lazily.
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-approval-decision-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  predicateFactory.mockClear();
});

const SITE: SmartApproverDecisionSite = {
  decisions: { name: 'typesafe', calibrated: true, decide: vi.fn() },
  mode: 'shadow',
  thresholds: {},
  timeoutMs: 2000,
};

const personalities = { get: () => undefined } as unknown as PersonalityRegistry;
const getProvider = async () => {
  throw new Error('the smart reviewer must not be constructed');
};

function bot(botKey: string): GatewayBotConfig {
  return {
    botKey,
    loop: { hooks: new DefaultHookRegistry() },
    binding: { type: 'personality', name: 'p' },
  } as unknown as GatewayBotConfig;
}

/** One Telegram-shaped card bot and one WhatsApp-shaped card-less bot. */
function wire(decision?: SmartApproverDecisionSite) {
  const card = {
    id: 'telegram:card',
    botKey: 'card',
    postApprovalCard: async () => ({ messageTs: 'ts' }),
    updateApprovalCard: async () => ({ ok: true }),
    onApprovalDecision: () => {},
  } as unknown as PlatformAdapter;
  const cardless = { id: 'whatsapp:plain', botKey: 'plain' } as unknown as PlatformAdapter;
  const gateway = { resolveApprovalRoute: () => undefined } as unknown as Gateway;
  return wireApprovalFlow(gateway, [bot('card'), bot('plain')], [card, cardless], {
    personalities,
    getProvider,
    model: 'm',
    approvalTimeoutMs: 0,
    ownerFor: () => undefined,
    ...(decision ? { decision } : {}),
  });
}

function decisionsPassed() {
  return predicateFactory.mock.calls.map(([opts]) => opts.decision);
}

describe('wireApprovalFlow — the decision site', () => {
  it('reaches every predicate it builds (card, no-surface, withoutSurface)', async () => {
    const flow = wire(SITE);
    // no-surface gate for `plain`, the card predicate, and `withoutSurface`.
    expect(predicateFactory).toHaveBeenCalledTimes(3);
    expect(decisionsPassed()).toEqual([SITE, SITE, SITE]);
    await flow.shutdown();
  });

  it('absent → no `decision` key on any predicate (R7)', async () => {
    const flow = wire();
    expect(predicateFactory).toHaveBeenCalledTimes(3);
    for (const [opts] of predicateFactory.mock.calls) expect(opts).not.toHaveProperty('decision');
    await flow.shutdown();
  });
});

describe('the unattended and no-surface gates — the decision site', () => {
  it('wireUnattendedApprovalGate forwards it, and omits it when absent', () => {
    const base = {
      personalities,
      getProvider,
      model: 'm',
      allowUnattendedDangerousTools: false,
      isRemoteSenderTurn: () => false,
    };
    // Each wire builds two predicates: the unattended gate's and the
    // remote-sender turns' no-surface gate's. Both carry the site.
    wireUnattendedApprovalGate(new DefaultHookRegistry(), { ...base, decision: SITE });
    wireUnattendedApprovalGate(new DefaultHookRegistry(), base);
    expect(predicateFactory).toHaveBeenCalledTimes(4);
    expect(predicateFactory.mock.calls[0]?.[0].decision).toBe(SITE);
    expect(predicateFactory.mock.calls[1]?.[0].decision).toBe(SITE);
    expect(predicateFactory.mock.calls[2]?.[0]).not.toHaveProperty('decision');
    expect(predicateFactory.mock.calls[3]?.[0]).not.toHaveProperty('decision');
  });

  it('createNoApprovalSurfaceGate forwards it, and omits it when absent', () => {
    const base = { personalities, getProvider, model: 'm' };
    createNoApprovalSurfaceGate([new DefaultHookRegistry()], { ...base, decision: SITE });
    createNoApprovalSurfaceGate([new DefaultHookRegistry()], base);
    expect(predicateFactory.mock.calls[0]?.[0].decision).toBe(SITE);
    expect(predicateFactory.mock.calls[1]?.[0]).not.toHaveProperty('decision');
  });
});

describe('hosts hand the seams the default-config build’s site (source text)', () => {
  it('ethos gateway: the systemLoop build’s approverDecision reaches both shared gates', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf-8');
    const start = src.slice(src.indexOf('export async function runGatewayStart'));
    // Destructured from the systemLoop's `createAgentLoop(config, …)`.
    expect(start).toMatch(
      /approverDecision,\s*dispose: disposeSystemLoop,[^}]*\} = await createAgentLoop\(config,/,
    );
    expect(start).toMatch(
      /wireUnattendedApprovalGate\(systemLoopReady\.hooks, \{[\s\S]*?\.\.\.\(approverDecision \? \{ decision: approverDecision \} : \{\}\),\s*\}\);/,
    );
    expect(start).toMatch(
      /wireApprovalFlow\(gateway, bots, adapters, \{[\s\S]*?\.\.\.\(approverDecision \? \{ decision: approverDecision \} : \{\}\),\s*\}\);/,
    );
  });

  it('ethos boot: the shared build’s approverDecision reaches the bot seams and the web API', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf-8');
    expect(src).toMatch(
      /const approvalSeams = \{[\s\S]*?\.\.\.\(shared\.approverDecision \? \{ decision: shared\.approverDecision \} : \{\}\),\s*\};/,
    );
    expect(src).toMatch(
      /buildServeWebApi\(\{[\s\S]*?loop: systemLoop,[\s\S]*?approverDecision: shared\.approverDecision/,
    );
  });

  it('ethos serve --team: the coordinator build’s approverDecision is used', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/serve.ts'), 'utf-8');
    expect(src).toMatch(
      /approverDecision: teamApproverDecision,\s*\} = await createTeamAgentLoop\(/,
    );
    expect(src).toContain('approverDecision = teamApproverDecision;');
    const wiring = await readFile(join(ROOT, 'apps/ethos/src/wiring.ts'), 'utf-8');
    expect(wiring).toContain('...(approverDecision ? { approverDecision } : {}),');
  });
});
