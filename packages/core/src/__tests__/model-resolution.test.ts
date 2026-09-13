import type {
  ModelDeviation,
  ModelRegistry,
  ModelResolutionContext,
  ModelResolutionFailure,
  ModelRoleName,
  PersonalityConfig,
  ResolvedModel,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  attemptWithFallbacks,
  describeDeviation,
  ModelFallbacksExhaustedError,
  parseModelDeclaration,
  resolveModel,
} from '../model-resolution';

// The registry every rung row below resolves against: four aliases on two
// provider ENTRIES, one bound role, one default.
function makeRegistry(overrides: Partial<ModelRegistry> = {}): ModelRegistry {
  return {
    entries: {
      sonnet: {
        alias: 'sonnet',
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        contextWindow: 200_000,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015,
      },
      opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
      haiku: { alias: 'haiku', provider: 'anthropic', modelId: 'claude-haiku-5' },
      qwen: { alias: 'qwen', provider: 'ollama-local', modelId: 'qwen2.5-coder:32b' },
    },
    default: 'sonnet',
    roles: { deep: 'opus' },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ModelResolutionContext> = {}): ModelResolutionContext {
  return { registry: makeRegistry(), routing: {}, ...overrides };
}

function personality(
  model?: PersonalityConfig['model'],
  id = 'engineer',
): Pick<PersonalityConfig, 'id' | 'model'> {
  return model === undefined ? { id } : { id, model };
}

function expectResolved(result: ResolvedModel | ModelResolutionFailure): ResolvedModel {
  if ('ok' in result) throw new Error(`expected a resolved model, got: ${result.reason}`);
  return result;
}

function expectFailure(result: ResolvedModel | ModelResolutionFailure): ModelResolutionFailure {
  if (!('ok' in result)) throw new Error(`expected a refusal, got alias ${result.alias}`);
  return result;
}

describe('resolveModel — one row per rung (D7)', () => {
  const rungs: Array<{
    name: string;
    input: Parameters<typeof resolveModel>[0];
    source: ResolvedModel['source'];
    alias: string;
  }> = [
    {
      name: 'rung 0 — a /model run pin',
      input: {
        personality: personality('haiku'),
        role: 'default',
        ctx: makeCtx({
          routing: { engineer: 'opus' },
          teamManifest: { personalityModels: { engineer: 'qwen' } },
        }),
        runOverride: 'sonnet',
      },
      source: 'run-override',
      alias: 'sonnet',
    },
    {
      name: 'rung 1 — the team manifest coordinator slot',
      input: {
        personality: personality('haiku'),
        role: 'default',
        ctx: makeCtx({ teamManifest: { coordinatorModel: 'opus' } }),
        isCoordinator: true,
      },
      source: 'team-coordinator',
      alias: 'opus',
    },
    {
      name: 'rung 1 — the team manifest personality slot',
      input: {
        personality: personality('haiku'),
        role: 'default',
        ctx: makeCtx({ teamManifest: { personalityModels: { engineer: 'qwen' } } }),
      },
      source: 'team-personality',
      alias: 'qwen',
    },
    {
      name: 'rung 2 — modelRouting',
      input: {
        personality: personality('haiku'),
        role: 'default',
        ctx: makeCtx({ routing: { engineer: 'opus' } }),
      },
      source: 'routing-override',
      alias: 'opus',
    },
    {
      name: 'rung 3 — the personality declaration',
      input: { personality: personality('haiku'), role: 'default', ctx: makeCtx() },
      source: 'personality',
      alias: 'haiku',
    },
    {
      name: 'rung 4 — the role binding',
      input: { personality: personality('deep'), role: 'default', ctx: makeCtx() },
      source: 'role-binding',
      alias: 'opus',
    },
    {
      name: 'rung 5 — the registry default',
      input: { personality: personality(), role: 'default', ctx: makeCtx() },
      source: 'default',
      alias: 'sonnet',
    },
  ];

  for (const row of rungs) {
    it(`${row.name} wins with source "${row.source}"`, () => {
      const resolved = expectResolved(resolveModel(row.input));
      expect(resolved.source).toBe(row.source);
      expect(resolved.alias).toBe(row.alias);
    });
  }
});

describe('resolveModel — one row per precedence pair (D7)', () => {
  const pairs: Array<{
    name: string;
    input: Parameters<typeof resolveModel>[0];
    alias: string;
    source: ResolvedModel['source'];
  }> = [
    {
      name: 'rung 0 beats rung 1',
      input: {
        personality: personality(),
        role: 'default',
        ctx: makeCtx({ teamManifest: { coordinatorModel: 'qwen' } }),
        isCoordinator: true,
        runOverride: 'haiku',
      },
      alias: 'haiku',
      source: 'run-override',
    },
    {
      name: 'rung 1 beats rung 2',
      input: {
        personality: personality(),
        role: 'default',
        ctx: makeCtx({
          routing: { engineer: 'qwen' },
          teamManifest: { personalityModels: { engineer: 'haiku' } },
        }),
      },
      alias: 'haiku',
      source: 'team-personality',
    },
    {
      name: 'rung 2 beats rung 3',
      input: {
        personality: personality('qwen'),
        role: 'default',
        ctx: makeCtx({ routing: { engineer: 'haiku' } }),
      },
      alias: 'haiku',
      source: 'routing-override',
    },
    {
      name: 'rung 3 beats rung 4',
      input: { personality: personality('haiku'), role: 'deep', ctx: makeCtx() },
      alias: 'haiku',
      source: 'personality',
    },
    {
      name: 'rung 4 beats rung 5',
      input: { personality: personality('deep'), role: 'default', ctx: makeCtx() },
      alias: 'opus',
      source: 'role-binding',
    },
  ];

  for (const row of pairs) {
    it(row.name, () => {
      const resolved = expectResolved(resolveModel(row.input));
      expect(resolved.alias).toBe(row.alias);
      expect(resolved.source).toBe(row.source);
    });
  }
});

describe('resolveModel — the rung order is identical solo and in a team (D7)', () => {
  it('a personality alias beats the role binding with and without a manifest', () => {
    const solo = expectResolved(
      resolveModel({ personality: personality('qwen'), role: 'deep', ctx: makeCtx() }),
    );
    const team = expectResolved(
      resolveModel({
        personality: personality('qwen'),
        role: 'deep',
        ctx: makeCtx({ teamManifest: {} }),
      }),
    );
    expect(solo.alias).toBe('qwen');
    expect(team.alias).toBe('qwen');
    expect(solo.source).toBe(team.source);
  });
});

describe('resolveModel — refusals (D6/D14)', () => {
  it('an unknown alias refuses the turn and names the configured aliases', () => {
    const failure = expectFailure(
      resolveModel({ personality: personality('gpt-9'), role: 'default', ctx: makeCtx() }),
    );
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe('model_unresolved');
    expect(failure.declared).toBe('gpt-9');
    expect(failure.configuredAliases).toEqual(['sonnet', 'opus', 'haiku', 'qwen']);
    expect(failure.reason).toContain('gpt-9');
  });

  it('a rung-0 /model pin naming an unknown alias refuses and lists the configured aliases', () => {
    const failure = expectFailure(
      resolveModel({
        personality: personality('sonnet'),
        role: 'default',
        ctx: makeCtx(),
        runOverride: 'claude-3',
      }),
    );
    expect(failure.declared).toBe('claude-3');
    expect(failure.configuredAliases).toEqual(['sonnet', 'opus', 'haiku', 'qwen']);
    expect(failure.fix).toContain('sonnet');
  });

  it('an empty registry refuses rather than guessing', () => {
    const failure = expectFailure(
      resolveModel({
        personality: personality(),
        role: 'default',
        ctx: { registry: { entries: {}, roles: {} }, routing: {} },
      }),
    );
    expect(failure.code).toBe('model_unresolved');
    expect(failure.configuredAliases).toEqual([]);
    expect(failure.reason).toContain('No models are configured');
  });

  it('a registry with entries but no default refuses', () => {
    const failure = expectFailure(
      resolveModel({
        personality: personality(),
        role: 'default',
        ctx: makeCtx({ registry: makeRegistry({ default: undefined, roles: {} }) }),
      }),
    );
    expect(failure.reason).toContain('no default model');
  });

  it('a role bound to a missing alias refuses and names the binding', () => {
    const failure = expectFailure(
      resolveModel({
        personality: personality('deep'),
        role: 'default',
        ctx: makeCtx({ registry: makeRegistry({ roles: { deep: 'ghost' } }) }),
      }),
    );
    expect(failure.declared).toBe('ghost');
    expect(failure.reason).toContain('"deep"');
  });
});

describe('resolveModel — deviations (D17)', () => {
  it('an unbound role falls through to the default and carries a role-unbound deviation', () => {
    const resolved = expectResolved(
      resolveModel({
        personality: personality('deep'),
        role: 'default',
        ctx: makeCtx({ registry: makeRegistry({ roles: {} }) }),
      }),
    );
    expect(resolved.alias).toBe('sonnet');
    expect(resolved.source).toBe('default');
    expect(resolved.pinned).toBe(false);
    expect(resolved.deviation?.kind).toBe('role-unbound');
    expect(resolved.deviation?.declared).toBe('deep');
    expect(resolved.deviation?.effective).toBe('sonnet');
    expect(resolved.deviation?.once).toBe(true);
  });

  it('declaring nothing and running on the default announces nothing', () => {
    const resolved = expectResolved(
      resolveModel({ personality: personality(), role: 'default', ctx: makeCtx() }),
    );
    expect(resolved.source).toBe('default');
    expect(resolved.deviation).toBeUndefined();
  });

  it('a team manifest outranking the personality announces once', () => {
    const resolved = expectResolved(
      resolveModel({
        personality: personality('qwen'),
        role: 'default',
        ctx: makeCtx({ teamManifest: { personalityModels: { engineer: 'haiku' } } }),
      }),
    );
    expect(resolved.deviation?.kind).toBe('outranked');
    expect(resolved.deviation?.declared).toBe('qwen');
    expect(resolved.deviation?.effective).toBe('haiku');
    expect(resolved.deviation?.once).toBe(true);
  });

  it('a /model run pin outranking the personality announces every time', () => {
    const resolved = expectResolved(
      resolveModel({
        personality: personality('qwen'),
        role: 'default',
        ctx: makeCtx(),
        runOverride: 'haiku',
      }),
    );
    expect(resolved.deviation?.kind).toBe('outranked');
    expect(resolved.deviation?.once).toBe(false);
  });

  it('a personality role declaration is not reported as outranked', () => {
    const resolved = expectResolved(
      resolveModel({ personality: personality('deep'), role: 'default', ctx: makeCtx() }),
    );
    expect(resolved.source).toBe('role-binding');
    expect(resolved.deviation).toBeUndefined();
  });
});

describe('resolveModel — pinned (D21)', () => {
  const rows: Array<{ name: string; input: Parameters<typeof resolveModel>[0]; pinned: boolean }> =
    [
      {
        name: 'rung 0',
        input: {
          personality: personality(),
          role: 'default',
          ctx: makeCtx(),
          runOverride: 'haiku',
        },
        pinned: true,
      },
      {
        name: 'rung 1',
        input: {
          personality: personality(),
          role: 'default',
          ctx: makeCtx({ teamManifest: { coordinatorModel: 'haiku' } }),
          isCoordinator: true,
        },
        pinned: true,
      },
      {
        name: 'rung 2',
        input: {
          personality: personality(),
          role: 'default',
          ctx: makeCtx({ routing: { engineer: 'haiku' } }),
        },
        pinned: true,
      },
      {
        name: 'rung 3',
        input: { personality: personality('haiku'), role: 'default', ctx: makeCtx() },
        pinned: true,
      },
      {
        name: 'a role binding the personality itself named',
        input: { personality: personality('deep'), role: 'default', ctx: makeCtx() },
        pinned: true,
      },
      {
        name: 'a role binding nobody named',
        input: { personality: personality(), role: 'deep', ctx: makeCtx() },
        pinned: false,
      },
      {
        name: 'rung 5, the default',
        input: { personality: personality(), role: 'default', ctx: makeCtx() },
        pinned: false,
      },
      {
        name: "an unbound role's fall-through",
        input: {
          personality: personality('deep'),
          role: 'default',
          ctx: makeCtx({ registry: makeRegistry({ roles: {} }) }),
        },
        pinned: false,
      },
    ];

  for (const row of rows) {
    it(`pinned is ${row.pinned} for ${row.name}`, () => {
      expect(expectResolved(resolveModel(row.input)).pinned).toBe(row.pinned);
    });
  }
});

describe('resolveModel — the entry it resolved to (D8/D12)', () => {
  it('resolved model carries its own provider', () => {
    const resolved = expectResolved(
      resolveModel({ personality: personality('qwen'), role: 'default', ctx: makeCtx() }),
    );
    // The alias names a provider ENTRY, so no code path can pair a model with a
    // provider it did not name — which is why the old provider-name guard is gone.
    expect(resolved.providerKey).toBe('ollama-local');
    expect(resolved.modelId).toBe('qwen2.5-coder:32b');
  });

  it('carries the context window and cost from the registry entry', () => {
    const resolved = expectResolved(
      resolveModel({ personality: personality('sonnet'), role: 'default', ctx: makeCtx() }),
    );
    expect(resolved.contextWindow).toBe(200_000);
    expect(resolved.cost).toEqual({ input: 0.003, output: 0.015 });
  });

  it('omits cost and context window when the entry declares neither', () => {
    const resolved = expectResolved(
      resolveModel({ personality: personality('opus'), role: 'default', ctx: makeCtx() }),
    );
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.cost).toBeUndefined();
  });

  it('reads a tier map by the requested role and falls back to its default leaf', () => {
    const model = { trivial: 'haiku', default: 'sonnet' };
    const deep = expectResolved(
      resolveModel({ personality: personality(model), role: 'trivial', ctx: makeCtx() }),
    );
    const missing = expectResolved(
      resolveModel({ personality: personality(model), role: 'dreaming', ctx: makeCtx() }),
    );
    expect(deep.alias).toBe('haiku');
    expect(missing.alias).toBe('sonnet');
  });
});

describe('parseModelDeclaration (D25)', () => {
  const aliases = ['sonnet', 'opus', 'qwen'] as const;
  const rows: Array<{
    value: unknown;
    verdict: 'role' | 'alias' | 'invalid';
    name?: string;
  }> = [
    { value: 'trivial', verdict: 'role' },
    { value: 'default', verdict: 'role' },
    { value: 'deep', verdict: 'role' },
    { value: 'dreaming', verdict: 'role' },
    { value: 'sonnet', verdict: 'alias' },
    { value: 'opus', verdict: 'alias' },
    { value: 'qwen', verdict: 'alias' },
    { value: '  sonnet  ', verdict: 'alias', name: 'a padded alias' },
    { value: 'Sonnet', verdict: 'invalid', name: 'a differently-cased alias' },
    { value: 'claude-sonnet-5', verdict: 'invalid', name: 'a raw vendor id' },
    { value: '', verdict: 'invalid', name: 'the empty string' },
    { value: '   ', verdict: 'invalid', name: 'whitespace' },
    { value: undefined, verdict: 'invalid', name: 'undefined' },
    { value: null, verdict: 'invalid', name: 'null' },
    { value: 42, verdict: 'invalid', name: 'a number' },
    { value: { default: 'sonnet' }, verdict: 'invalid', name: 'a tier map object' },
    { value: ['sonnet'], verdict: 'invalid', name: 'an array' },
    { value: '__proto__', verdict: 'invalid', name: 'a prototype key' },
  ];

  for (const row of rows) {
    it(`${row.name ?? JSON.stringify(row.value)} parses as ${row.verdict}`, () => {
      const parsed = parseModelDeclaration(row.value, { aliases });
      expect(parsed.kind).toBe(row.verdict);
    });
  }

  it('a role name is never read as an alias, even if a registry smuggles one in', () => {
    // D1 reserves the four role names and `validateModelRegistry` refuses an
    // alias called `deep`; this pins the parser's own answer if one ever arrives.
    const parsed = parseModelDeclaration('deep', { aliases: ['deep'] });
    expect(parsed).toEqual({ kind: 'role', role: 'deep' });
  });

  it('a near miss is suggested rather than the whole roster', () => {
    const parsed = parseModelDeclaration('sonnett', { aliases });
    if (parsed.kind !== 'invalid') throw new Error('expected invalid');
    expect(parsed.suggestions).toEqual(['sonnet']);
  });

  it('with no near miss, every legal value is listed', () => {
    const parsed = parseModelDeclaration('zzzz', { aliases });
    if (parsed.kind !== 'invalid') throw new Error('expected invalid');
    expect(parsed.suggestions).toEqual([
      'trivial',
      'default',
      'deep',
      'dreaming',
      'sonnet',
      'opus',
      'qwen',
    ]);
  });

  it('resolveModel and parseModelDeclaration agree on every row', () => {
    const registry = makeRegistry({
      entries: {
        sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
        opus: { alias: 'opus', provider: 'anthropic', modelId: 'claude-opus-5' },
        qwen: { alias: 'qwen', provider: 'ollama-local', modelId: 'qwen2.5-coder:32b' },
      },
    });
    for (const row of rows) {
      const parsed = parseModelDeclaration(row.value, { aliases });
      const resolved = resolveModel({
        personality: personality(row.value as PersonalityConfig['model']),
        role: 'default',
        ctx: { registry, routing: {} },
      });
      // A string this parser refuses must never resolve through the resolver,
      // and vice versa — that is the drift D25 exists to prevent. Values that
      // are not a non-empty string are not a declaration at ALL: rung 3 reads a
      // string or a tier map and finds nothing there, so the resolver falls to a
      // lower rung rather than refusing, while the parser (whose callers hand it
      // a single slot's value) calls the same input invalid. Both are right, and
      // neither is a grammar disagreement.
      if (typeof row.value !== 'string' || row.value.trim().length === 0) continue;
      expect('ok' in resolved).toBe(parsed.kind === 'invalid');
    }
  });
});

describe('attemptWithFallbacks (D17 row 2)', () => {
  const registry: ModelRegistry = {
    entries: {
      opus: {
        alias: 'opus',
        provider: 'anthropic',
        modelId: 'claude-opus-5',
        fallbacks: ['opus-batch', 'opus-eu', 'qwen'],
      },
      'opus-batch': { alias: 'opus-batch', provider: 'anthropic', modelId: 'claude-opus-5-batch' },
      'opus-eu': { alias: 'opus-eu', provider: 'anthropic', modelId: 'claude-opus-5-eu' },
      // Cross-provider on purpose: it must be skipped, never tried.
      qwen: { alias: 'qwen', provider: 'ollama-local', modelId: 'qwen2.5-coder:32b' },
    },
    default: 'opus',
    roles: {},
  };

  const primary: ResolvedModel = {
    alias: 'opus',
    providerKey: 'anthropic',
    modelId: 'claude-opus-5',
    source: 'personality',
    pinned: true,
  };

  it('does not announce anything when the primary answers', async () => {
    const onDeviation = vi.fn();
    const out = await attemptWithFallbacks({
      resolved: primary,
      registry,
      attempt: async () => 'ok',
      onDeviation,
    });
    expect(out).toBe('ok');
    expect(onDeviation).not.toHaveBeenCalled();
  });

  it('a declared fallback is used and announced every time, not once', async () => {
    const seen: ModelDeviation[] = [];
    const run = async (): Promise<string> =>
      attemptWithFallbacks({
        resolved: primary,
        registry,
        attempt: async (m) => {
          if (m.alias === 'opus') throw new Error('529 overloaded');
          return m.alias;
        },
        onDeviation: (d) => seen.push(d),
      });

    expect(await run()).toBe('opus-batch');
    expect(await run()).toBe('opus-batch');
    expect(seen).toHaveLength(2);
    for (const d of seen) {
      expect(d.kind).toBe('entry-fallback');
      expect(d.declared).toBe('opus');
      expect(d.effective).toBe('opus-batch');
      expect(d.once).toBe(false);
      expect(d.reason).toContain('529 overloaded');
    }
  });

  it('fallbacks are exhausted in declared order and then the turn refuses', async () => {
    const tried: string[] = [];
    await expect(
      attemptWithFallbacks({
        resolved: primary,
        registry,
        attempt: async (m) => {
          tried.push(m.alias);
          throw new Error(`${m.alias} is down`);
        },
      }),
    ).rejects.toBeInstanceOf(ModelFallbacksExhaustedError);
    // `qwen` is a cross-provider fallback and is skipped, never attempted: an
    // expired local token must not become an egress event (D6).
    expect(tried).toEqual(['opus', 'opus-batch', 'opus-eu']);
  });

  it('the refusal carries the D6 shape and the last vendor error', async () => {
    const error = await attemptWithFallbacks({
      resolved: primary,
      registry,
      attempt: async (m) => {
        throw new Error(`${m.alias} is down`);
      },
    }).catch((e: unknown) => e);
    if (!(error instanceof ModelFallbacksExhaustedError)) throw new Error('expected the refusal');
    expect(error.failure.code).toBe('model_unresolved');
    expect(error.failure.declared).toBe('opus');
    expect(error.failure.reason).toContain('opus-eu is down');
    expect(error.failure.configuredAliases).toContain('opus-batch');
  });

  it('an entry with no usable fallback propagates the original error untouched', async () => {
    const original = new Error('401 invalid x-api-key');
    const thrown = await attemptWithFallbacks({
      resolved: { ...primary, alias: 'opus-batch', modelId: 'claude-opus-5-batch' },
      registry,
      attempt: async () => {
        throw original;
      },
    }).catch((e: unknown) => e);
    expect(thrown).toBe(original);
  });

  it('a fallback attempt carries the fallback entry, not the primary', async () => {
    const attempted: ResolvedModel[] = [];
    await attemptWithFallbacks({
      resolved: primary,
      registry,
      attempt: async (m) => {
        attempted.push(m);
        if (m.alias === 'opus') throw new Error('down');
        return m.alias;
      },
    });
    expect(attempted[1]?.modelId).toBe('claude-opus-5-batch');
    expect(attempted[1]?.providerKey).toBe('anthropic');
    expect(attempted[1]?.pinned).toBe(true);
    expect(attempted[1]?.deviation?.kind).toBe('entry-fallback');
  });
});

describe('describeDeviation (D17)', () => {
  const kinds: ModelDeviation['kind'][] = [
    'role-unbound',
    'entry-fallback',
    'chain-failover',
    'credential-rejected',
    'legacy-id-mapped',
    'outranked',
  ];

  for (const kind of kinds) {
    it(`renders a ${kind} deviation naming both the declared and the effective model`, () => {
      const { line } = describeDeviation({
        kind,
        declared: 'deep',
        effective: 'sonnet',
        reason: 'the vendor said no',
        once: true,
      });
      expect(line).toContain('deep');
      expect(line).toContain('sonnet');
      expect(line).toContain('the vendor said no');
    });
  }

  it('renders the D17 row 1 sentence for an unbound role', () => {
    const out = describeDeviation({
      kind: 'role-unbound',
      declared: 'deep',
      effective: 'sonnet',
      reason: "anthropic · claude-sonnet-5 is this machine's default model.",
      fix: 'Bind one in Settings → Models.',
      once: true,
    });
    expect(out.line).toBe(
      'Asked for a "deep" model. Nothing is bound to "deep" on this machine, so it is running on the default — sonnet. anthropic · claude-sonnet-5 is this machine\'s default model.',
    );
    expect(out.fix).toBe('Bind one in Settings → Models.');
  });

  it("keeps the vendor's own words verbatim", () => {
    const vendor = '{"type":"error","error":{"type":"not_found_error","message":"model: x"}}';
    const { line } = describeDeviation({
      kind: 'credential-rejected',
      declared: 'anthropic',
      effective: 'qwen',
      reason: vendor,
      once: false,
    });
    expect(line).toContain(vendor);
  });

  it('supplies the fix the row specifies when the deviation carries none', () => {
    const out = describeDeviation({
      kind: 'legacy-id-mapped',
      declared: 'claude-sonnet-4-6',
      effective: 'sonnet',
      reason: '',
      once: true,
    });
    expect(out.fix).toContain('0.10.0');
    expect(out.line).not.toMatch(/\s$/);
  });

  it('omits a fix for a deviation whose row names none', () => {
    const out = describeDeviation({
      kind: 'chain-failover',
      declared: 'anthropic',
      effective: 'openrouter · anthropic/claude-sonnet-5',
      reason: 'rate limited',
      once: false,
    });
    expect(out.fix).toBeUndefined();
  });

  it('the resolver and the renderer agree — every deviation it produces renders', () => {
    const roles: ModelRoleName[] = ['trivial', 'deep', 'dreaming'];
    for (const role of roles) {
      const resolved = expectResolved(
        resolveModel({
          personality: personality(role),
          role: 'default',
          ctx: makeCtx({ registry: makeRegistry({ roles: {} }) }),
        }),
      );
      const deviation = resolved.deviation;
      if (!deviation) throw new Error(`expected a deviation for role ${role}`);
      expect(describeDeviation(deviation).line).toContain(role);
    }
  });
});
