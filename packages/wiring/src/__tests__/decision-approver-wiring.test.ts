// Wiring of the smart approver's decision site (plan/phases/decision-provider-jev.md
// §8.2, §14 R7). Two seams:
// - `createApprovalDangerPredicate` constructs the reviewer with exactly
//   today's options when no `decision` is passed, and forwards it when one is;
// - `createAgentLoop` exposes `approverDecision` only when a provider exists
//   and the approver site is `shadow`/`on`, and that site carries the build's
//   ONE provider instance (the one the injection classifier also uses).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECISIONS_API_KEY_REF } from '@ethosagent/config';
import { DefaultHookRegistry, DefaultPersonalityRegistry } from '@ethosagent/core';
import { createTypesafeDecisionProvider } from '@ethosagent/decision-typesafe';
import type {
  CompletionChunk,
  DecisionProvider,
  LLMProvider,
  SecretsResolver,
} from '@ethosagent/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApprovalDangerPredicate } from '../approval-seams';
import { createAgentLoop, type WiringConfig } from '../index';
import { createSmartApprover, type SmartApproverDecisionSite } from '../smart-approver';

vi.mock('../smart-approver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../smart-approver')>();
  return { ...actual, createSmartApprover: vi.fn(actual.createSmartApprover) };
});

vi.mock('@ethosagent/decision-typesafe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/decision-typesafe')>();
  return {
    ...actual,
    createTypesafeDecisionProvider: vi.fn(actual.createTypesafeDecisionProvider),
  };
});

const approverFactory = vi.mocked(createSmartApprover);
const providerFactory = vi.mocked(createTypesafeDecisionProvider);

beforeEach(() => {
  approverFactory.mockClear();
  providerFactory.mockClear();
});

function reviewer(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: '{"decision":"deny","reason":"llm denies"}' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function smartPredicate(decision?: SmartApproverDecisionSite) {
  const hooks = new DefaultHookRegistry();
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'p', name: 'p', safety: { approvalMode: 'smart' } });
  const getProvider = async () => reviewer();
  const isDangerous = createApprovalDangerPredicate({
    hooks: [hooks],
    personalities,
    getProvider,
    model: 'reviewer-model',
    alwaysAsk: ['email_send'],
    ...(decision ? { decision } : {}),
  });
  await hooks.fireVoid('session_start', {
    sessionId: 's',
    sessionKey: 'k',
    platform: 'web',
    personalityId: 'p',
  });
  const reason = await isDangerous({
    sessionId: 's',
    toolCallId: 'tc',
    toolName: 'email_send',
    args: { to: 'a@b' },
  });
  return { reason, getProvider };
}

describe('createApprovalDangerPredicate — the approver decision site', () => {
  it('no decision → the reviewer is constructed with exactly today’s options', async () => {
    const { reason } = await smartPredicate();
    expect(reason).toBe('denied by reviewer: llm denies');
    expect(approverFactory).toHaveBeenCalledTimes(1);
    expect(Object.keys(approverFactory.mock.calls[0]?.[0] ?? {})).toEqual(['getProvider', 'model']);
  });

  it('a decision site is forwarded to the reviewer, and an `on` Jev deny is acted on', async () => {
    const decide = vi.fn(async () => ({
      ok: true as const,
      answers: {
        approver: {
          type: 'choice' as const,
          choice: 'deny',
          probabilities: { deny: 0.95 },
          confidence: 0.95,
        },
      },
      model: 'jev-1.13.0',
      usage: { inputTokens: 5, outputTokens: 0 },
    }));
    const decisions: DecisionProvider = { name: 'typesafe', calibrated: true, decide };
    const site: SmartApproverDecisionSite = {
      decisions,
      mode: 'on',
      thresholds: { approve: 0.9, deny: 0.9 },
      timeoutMs: 2000,
    };
    const { reason } = await smartPredicate(site);
    expect(approverFactory.mock.calls[0]?.[0].decision).toBe(site);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(reason).toBe('denied by reviewer: email_send requires explicit approval');
  });
});

describe('createAgentLoop — approverDecision', () => {
  let home: string;
  let dataDir: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-decision-approver-'));
    dataDir = join(home, '.ethos');
    mkdirSync(dataDir, { recursive: true });
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function keyed(): SecretsResolver {
    const values: Record<string, string> = { [DECISIONS_API_KEY_REF]: 'ts-live-key' };
    return {
      get: async (ref) => values[ref] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => Object.keys(values),
    };
  }

  /** Offline provider: nothing here sends a completion. */
  function config(extra: Partial<WiringConfig> = {}): WiringConfig {
    return {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      secretsResolver: keyed(),
      ...extra,
    };
  }

  function build(cfg: WiringConfig) {
    return createAgentLoop(cfg, { dataDir, workingDir: home, profile: 'cli', disableDocker: true });
  }

  it('no decisions.* keys → no approverDecision and no provider (R7)', async () => {
    const result = await build(config());
    try {
      expect(result.approverDecision).toBeUndefined();
      expect(providerFactory).not.toHaveBeenCalled();
    } finally {
      await result.dispose();
    }
  }, 60_000);

  it('provider set, approver off (injection shadow) → no approverDecision', async () => {
    const result = await build(
      config({ decisions: { provider: 'typesafe', sites: { injection: 'shadow' } } }),
    );
    try {
      expect(result.approverDecision).toBeUndefined();
      expect(providerFactory).toHaveBeenCalledTimes(1);
    } finally {
      await result.dispose();
    }
  }, 60_000);

  it('both sites shadow → ONE provider, shared by the approver site', async () => {
    const result = await build(
      config({
        decisions: {
          provider: 'typesafe',
          sites: { injection: 'shadow', approver: 'shadow' },
          thresholds: { approver: { approve: 0.9 } },
        },
      }),
    );
    try {
      expect(providerFactory).toHaveBeenCalledTimes(1);
      const site = result.approverDecision;
      expect(site?.decisions).toBe(providerFactory.mock.results[0]?.value);
      expect(site?.mode).toBe('shadow');
      expect(site?.timeoutMs).toBe(2000);
      expect(site?.thresholds).toEqual({ approve: 0.9 });
    } finally {
      await result.dispose();
    }
  }, 60_000);

  it('approver `on` without both thresholds runs as shadow (R6)', async () => {
    const result = await build(
      config({
        decisions: {
          provider: 'typesafe',
          sites: { approver: 'on' },
          thresholds: { approver: { approve: 0.9 } },
        },
      }),
    );
    try {
      expect(result.approverDecision?.mode).toBe('shadow');
    } finally {
      await result.dispose();
    }
  }, 60_000);
});
