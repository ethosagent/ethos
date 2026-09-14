import type { ModelReferent, ModelRegistryTestResult } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  catalogSuggestions,
  cooldownSeconds,
  credentialView,
  declarationGroups,
  declarationLabel,
  defaultRadioValue,
  draftSavable,
  draftTestable,
  emptyDraft,
  formatContextWindow,
  formatCost,
  lastTestView,
  pickCatalogModel,
  providerTypeOf,
  referentText,
  repointChoices,
  routablePersonalityIds,
  testAllByAlias,
  testButtonState,
  testedAtFor,
  unboundLabel,
  upsertRequest,
} from '../lib/model-registry';
import { CATALOG, registryList } from './model-registry-fixture';

// The pure half of Settings → Models (plan/phases/model-registry.md T2.3, T2.4,
// T2.7, T2.8, T2.12). What a click DOES is pinned in `models-pane.test.ts`
// against real Antd controls; what the click DECIDES is pinned here.

const OK: ModelRegistryTestResult = {
  state: 'ok',
  alias: 'opus',
  providerKey: 'anthropic-work',
  provider: 'anthropic',
  modelId: 'claude-opus-5',
  latencyMs: 300,
};

const UNREACHABLE: ModelRegistryTestResult = {
  state: 'unreachable',
  alias: 'qwen',
  providerKey: 'local-ollama',
  provider: 'ollama',
  modelId: 'qwen2.5-coder:32b',
  error: 'connect ECONNREFUSED 127.0.0.1:11434',
};

describe('the models table', () => {
  it('formats context, cost and key status the way the mockup reads', () => {
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(1_048_576)).toBe('1M');
    expect(formatContextWindow(null)).toBe('—');
    expect(formatCost(0.003, 0.015)).toBe('$0.003 · $0.015');
    expect(formatCost(null, null)).toBe('—');
    expect(credentialView('set').text).toBe('✓ set');
    expect(credentialView('missing')).toMatchObject({ tone: 'err', text: '✗ no key' });
    expect(credentialView('not_needed')).toMatchObject({ tone: 'muted', text: 'not needed' });
  });

  it('checks the stored default, and never a radio for a default the file does not have', () => {
    expect(defaultRadioValue(registryList())).toBe('sonnet');
    expect(defaultRadioValue(registryList({ default: 'gone' }))).toBeNull();
    expect(defaultRadioValue(registryList({ entries: [], default: null }))).toBeNull();
  });

  it('an unreachable last test reads as could-not-reach, not as a refusal', () => {
    expect(lastTestView(UNREACHABLE)).toEqual({
      tone: 'warn',
      text: '⚠ could not reach local-ollama',
      title: 'connect ECONNREFUSED 127.0.0.1:11434',
    });
    expect(lastTestView(undefined)).toMatchObject({ tone: 'muted', text: 'not tested' });
  });
});

describe('the Test button (T2.8)', () => {
  const ready = { credential: 'set' as const, providerKey: 'anthropic-work', ready: true };

  it('the button is disabled for 10s after a test, and the handler refusal is never reached on the ordinary path', () => {
    const t0 = 1_000_000;
    expect(testButtonState({ ...ready, testedAt: undefined, now: t0 })).toEqual({
      disabled: false,
      label: 'Test',
      reason: null,
    });
    expect(testButtonState({ ...ready, testedAt: t0, now: t0 })).toMatchObject({
      disabled: true,
      label: 'Test · 10s',
    });
    expect(testButtonState({ ...ready, testedAt: t0, now: t0 + 9_001 })).toMatchObject({
      disabled: true,
      label: 'Test · 1s',
    });
    // The window closes exactly when the handler's does, never earlier.
    expect(testButtonState({ ...ready, testedAt: t0, now: t0 + 10_000 })).toMatchObject({
      disabled: false,
      label: 'Test',
    });
  });

  it('keeps a rate_limited answer in step with the handler window', () => {
    const limited: ModelRegistryTestResult = {
      state: 'rate_limited',
      alias: 'sonnet',
      retryAfterSeconds: 4,
    };
    expect(cooldownSeconds(testedAtFor(limited, 50_000), 50_000)).toBe(4);
    expect(testedAtFor(OK, 50_000)).toBe(50_000);
  });

  it('is disabled, with the reason, when the provider entry has no key', () => {
    expect(
      testButtonState({
        ...ready,
        credential: 'missing',
        providerKey: 'openai-main',
        testedAt: undefined,
        now: 0,
      }),
    ).toEqual({
      disabled: true,
      label: 'Test',
      reason: 'openai-main has no API key. Add it with Edit on that provider.',
    });
  });

  it('Test all maps each entry outcome onto every alias of that provider entry', () => {
    expect(
      testAllByAlias({
        results: [
          { providerKey: 'anthropic-work', aliases: ['opus', 'sonnet'], outcome: OK },
          { providerKey: 'local-ollama', aliases: ['qwen'], outcome: UNREACHABLE },
        ],
      }),
    ).toEqual({ opus: OK, sonnet: OK, qwen: UNREACHABLE });
  });
});

describe('the Add/Edit drawer (T2.4)', () => {
  // The catalog (`ModelCatalogOutput`) carries id, label and context window —
  // no pricing — so a pick fills the context window and leaves cost as typed.
  it('picking a catalogued model prefills context (the catalog has no cost to prefill)', () => {
    const list = registryList();
    const suggestions = catalogSuggestions(CATALOG, providerTypeOf(list, 'anthropic-work'));
    expect(suggestions.map((s) => s.value)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']);
    const [sonnet] = suggestions;
    if (!sonnet) throw new Error('fixture catalog missing');
    const draft = pickCatalogModel(
      { ...emptyDraft(), alias: 'fast', provider: 'anthropic-work', costPer1kInput: 0.003 },
      sonnet,
    );
    expect(draft).toMatchObject({
      modelId: 'claude-sonnet-5',
      contextWindow: 200_000,
      costPer1kInput: 0.003,
      costPer1kOutput: null,
    });
  });

  it('a hand-typed ollama id is accepted and saved', () => {
    const typed = 'qwen2.5-coder:32b-instruct-q4_K_M';
    const list = registryList();
    expect(
      catalogSuggestions(CATALOG, providerTypeOf(list, 'local-ollama')).map((s) => s.value),
    ).not.toContain(typed);
    expect(
      upsertRequest(
        { ...emptyDraft(), alias: ' coder ', provider: 'local-ollama', modelId: ` ${typed} ` },
        'create',
      ),
    ).toEqual({ mode: 'create', alias: 'coder', provider: 'local-ollama', modelId: typed });
  });

  it('sends optional fields only when set, so an update clears what was emptied', () => {
    expect(
      upsertRequest(
        {
          alias: 'sonnet',
          provider: 'anthropic-work',
          modelId: 'claude-sonnet-5',
          label: '  ',
          contextWindow: 200_000,
          costPer1kInput: 0,
          costPer1kOutput: null,
        },
        'update',
      ),
    ).toEqual({
      mode: 'update',
      alias: 'sonnet',
      provider: 'anthropic-work',
      modelId: 'claude-sonnet-5',
      contextWindow: 200_000,
      costPer1kInput: 0,
    });
  });

  it('the Add-form Test works before the entry is saved — it needs no alias', () => {
    const unsaved = { ...emptyDraft(), provider: 'local-ollama', modelId: 'qwen2.5-coder:32b' };
    expect(draftTestable(unsaved)).toBe(true);
    expect(draftSavable(unsaved)).toBe(false);
    expect(draftTestable({ ...unsaved, modelId: ' ' })).toBe(false);
  });
});

describe('removal (T2.12)', () => {
  it('removing a referenced alias lists every personality and role binding that names it', () => {
    const referents: ModelReferent[] = [
      { kind: 'personality', personalityId: 'researcher-eu', field: 'model', readOnly: false },
      { kind: 'personality', personalityId: 'engineer', field: 'model.deep', readOnly: true },
      { kind: 'personality', personalityId: 'narrator', field: 'voice.model', readOnly: false },
      { kind: 'role', role: 'deep' },
      { kind: 'default' },
      { kind: 'routing', personalityId: 'pr-reviewer' },
      { kind: 'fallback', alias: 'sonnet' },
    ];
    expect(referents.map(referentText)).toEqual([
      'personality researcher-eu',
      'personality engineer (model.deep), built-in and read-only',
      'personality narrator (voice.model)',
      'role deep',
      'the default model',
      'routing for pr-reviewer',
      'fallback of sonnet',
    ]);
  });

  it('offers every other alias as a repoint target, the default first', () => {
    expect(repointChoices(registryList(), 'opus')).toEqual(['sonnet', 'qwen', 'gpt']);
    expect(repointChoices(registryList(), 'sonnet')).toEqual(['opus', 'qwen', 'gpt']);
  });
});

describe('roles and routing (T2.3, T2.7)', () => {
  it('the alias list is the registry', () => {
    const list = registryList();
    const [roles, models] = declarationGroups(list);
    expect(roles?.options.map((o) => o.value)).toEqual(['trivial', 'default', 'deep', 'dreaming']);
    expect(models?.options.map((o) => o.value)).toEqual(list.entries.map((e) => e.alias));
    expect(roles?.options.map((o) => o.hint)).toEqual([
      'unbound, uses sonnet',
      'sonnet',
      'opus',
      'unbound, uses sonnet',
    ]);
    expect(declarationLabel(list, 'deep')).toBe('deep → opus');
    expect(declarationLabel(list, 'qwen')).toBe('qwen');
    expect(unboundLabel(list)).toBe('Unbound, uses sonnet');
  });

  it('lets a routing row pick only personalities without an override, or its own', () => {
    const routing = { 'pr-reviewer': 'deep' };
    const ids = ['engineer', 'pr-reviewer', 'researcher-eu'];
    expect(routablePersonalityIds(ids, routing, null)).toEqual(['engineer', 'researcher-eu']);
    expect(routablePersonalityIds(ids, routing, 'pr-reviewer')).toEqual(ids);
  });
});
