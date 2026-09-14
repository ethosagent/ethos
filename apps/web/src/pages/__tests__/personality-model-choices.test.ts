// A personality's `model` and `voice.model` are declarations — a role or a
// registry alias — resolved per turn by `resolveTurnModel`
// (packages/core/src/agent-loop/turn-model.ts). The editor offers exactly those,
// closed: a vendor id typed into a free-text box is how an unusable model got
// saved (plan model-registry D5, T2.5), and Test next to the picker probes what
// the selection resolves to (T2.9).
//
// `renderToStaticMarkup` needs no DOM; the registry query is seeded into the
// cache so the control renders as it does against a configured deployment.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRegistryEntryView, ModelRegistryListResult } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  MODEL_REGISTRY_LIST_KEY,
  ModelDeclarationSelect,
} from '../../components/personality/ModelDeclarationSelect';
import {
  classifyDeclaration,
  type DeclaredModel,
  missingCredentialReason,
  modelDeclarationGroups,
  resolveTestTarget,
  unknownDeclarationNote,
} from '../../components/personality/modelDeclaration';

function entry(over: Partial<ModelRegistryEntryView> & { alias: string }): ModelRegistryEntryView {
  return {
    providerKey: 'anthropic-main',
    modelId: `${over.alias}-vendor-id`,
    label: null,
    contextWindow: null,
    costPer1kInput: null,
    costPer1kOutput: null,
    fallbacks: [],
    credential: 'set',
    referents: [],
    ...over,
  };
}

function registry(over: Partial<ModelRegistryListResult> = {}): ModelRegistryListResult {
  return {
    entries: [
      entry({ alias: 'sonnet', label: 'everyday driver' }),
      entry({ alias: 'opus', label: 'hard problems' }),
      entry({ alias: 'haiku', label: 'cheap summaries' }),
      entry({ alias: 'gpt', providerKey: 'openai-main', credential: 'missing' }),
    ],
    default: 'sonnet',
    roles: { trivial: 'haiku', default: null, deep: 'opus', dreaming: null },
    providerEntries: [],
    chainModels: [],
    routing: {},
    problems: [],
    ...over,
  };
}

function markup(value: DeclaredModel, data: ModelRegistryListResult = registry()): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(MODEL_REGISTRY_LIST_KEY, data);
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ModelDeclarationSelect, { value, onChange: () => {}, ariaLabel: 'Model' }),
      ),
    ),
  );
  return html.replaceAll('&#x27;', "'");
}

const values = (groups: ReturnType<typeof modelDeclarationGroups>) =>
  groups.map((g) => ({ key: g.key, values: g.options.map((o) => o.value) }));

const src = (...path: string[]) => readFileSync(join(import.meta.dirname, '..', ...path), 'utf8');

describe('the personality model control', () => {
  const page = src('Personalities.tsx');
  const voiceFields = src('..', 'components', 'personality', 'PersonalityVoiceFields.tsx');
  const control = src('..', 'components', 'personality', 'ModelDeclarationSelect.tsx');

  it('no free-text model control exists on any personality model field, voice.model included', () => {
    expect(page).not.toContain('AutoComplete');
    expect(page.match(/<ModelDeclarationSelect\b/g)?.length).toBe(2);
    const fastLane = voiceFields.slice(voiceFields.indexOf('label="Fast-lane model"'));
    expect(fastLane.slice(0, fastLane.indexOf('</Form.Item>'))).toContain(
      '<ModelDeclarationSelect',
    );
    expect(voiceFields).not.toContain('placeholder="claude-haiku-4-5"');
    expect(control).not.toMatch(/<AutoComplete\b/);
    expect(control).not.toContain('<Input');
    expect(control).not.toMatch(/mode=["{]/);
  });

  it('removes the personality provider Select from both the create drawer and the edit form', () => {
    expect(page).not.toContain('label="Provider"');
    expect(page).not.toMatch(/provider: (values|state)\.provider/);
  });

  it('omits model from the update patch while the control is untouched', () => {
    expect(page).toContain('...(modelChoice !== null ? { model: modelChoice } : {})');
  });

  it('voice.model offers the same roles and aliases as the agentic field', () => {
    const data = registry();
    const agentic = modelDeclarationGroups(data);
    const voice = modelDeclarationGroups(data, 'this personality’s model');
    expect(values(voice)).toEqual(values(agentic));
    expect(values(agentic)).toEqual([
      { key: 'default', values: [''] },
      { key: 'roles', values: ['trivial', 'default', 'deep', 'dreaming'] },
      { key: 'models', values: ['sonnet', 'opus', 'haiku', 'gpt'] },
    ]);
  });

  it('labels roles with their binding, and an unbound role with its fall-through', () => {
    const roles = modelDeclarationGroups(registry())[1]?.options ?? [];
    expect(roles.find((o) => o.value === 'deep')?.hint).toBe('→ opus');
    expect(roles.find((o) => o.value === 'dreaming')?.hint).toBe('unbound, uses sonnet');
    expect(modelDeclarationGroups(registry())[0]?.options[0]?.hint).toBe('sonnet');
  });

  it('the default role shows the registry default as its binding, never "unbound"', () => {
    const roleHint = (d: ModelRegistryListResult) =>
      modelDeclarationGroups(d)[1]?.options.find((o) => o.value === 'default')?.hint;
    // The smoke-test config: `modelRegistry.default: sonnet`, no `roles.default` line.
    expect(roleHint(registry())).toBe('→ sonnet');
    // A hand-written `modelRegistry.roles.default` is rung 4 and wins over rung 5.
    expect(
      roleHint(registry({ roles: { trivial: null, default: 'opus', deep: null, dreaming: null } })),
    ).toBe('→ opus');
    expect(roleHint(registry({ default: null }))).toBe('no default set');
    expect(roleHint(registry({ default: null }))).not.toContain('unbound');
  });

  it('an alias with no credential is disabled and states why', () => {
    const models = modelDeclarationGroups(registry())[2]?.options ?? [];
    const gpt = models.find((o) => o.value === 'gpt');
    expect(gpt?.disabled).toBe(true);
    expect(gpt?.hint).toBe('openai-main has no API key');
    expect(models.filter((o) => o.disabled).map((o) => o.value)).toEqual(['gpt']);
  });

  it('no capability value disables, hides or reorders an option', () => {
    const data = registry({
      entries: [
        entry({ alias: 'tiny', contextWindow: 2048, costPer1kInput: 99, label: 'no tools' }),
        entry({ alias: 'local', providerKey: 'ollama', credential: 'not_needed' }),
        entry({ alias: 'big', contextWindow: 1_000_000, costPer1kOutput: 0, fallbacks: ['tiny'] }),
      ],
    });
    const models = modelDeclarationGroups(data)[2]?.options ?? [];
    expect(models.map((o) => o.value)).toEqual(['tiny', 'local', 'big']);
    expect(models.every((o) => !o.disabled)).toBe(true);
  });

  it('an empty registry shows the add-a-model prompt', () => {
    const html = markup('', registry({ entries: [], default: null }));
    expect(html).toContain('No models yet. Add one in');
    expect(html).toContain('href="/settings/models"');
    expect(html).toContain('Settings → Models');
  });

  it('flags a raw vendor id and keeps it, rather than rewriting it', () => {
    const data = registry();
    expect(classifyDeclaration('claude-opus-4-7', data)).toEqual({
      kind: 'unknown',
      value: 'claude-opus-4-7',
    });
    const html = markup('claude-opus-4-7');
    expect(html).toContain(
      "claude-opus-4-7</span> isn't a model on this machine — choose one from the list",
    );
    expect(resolveTestTarget(classifyDeclaration('claude-opus-4-7', data), data)).toEqual({
      ok: false,
      reason: unknownDeclarationNote('claude-opus-4-7'),
    });
  });

  it('shows a tier map read-only and says a choice replaces it', () => {
    const map = { trivial: 'haiku', deep: 'opus' };
    expect(classifyDeclaration(map, registry())).toEqual({
      kind: 'tierMap',
      summary: 'trivial=haiku, deep=opus',
    });
    const html = markup(map);
    expect(html).toContain('Per-tier map: trivial=haiku, deep=opus.');
    expect(html).toContain('Choosing a value here replaces it');
  });
});

describe('Test beside the picker', () => {
  const data = registry();
  const target = (declared: DeclaredModel, d = data) =>
    resolveTestTarget(classifyDeclaration(declared, d), d);

  it('the picker Test tests the resolved model, not the declared string', () => {
    expect(target('deep')).toEqual({ ok: true, alias: 'opus', note: null });
    expect(target('haiku')).toEqual({ ok: true, alias: 'haiku', note: null });
  });

  it('testing "Use default" tests the default alias', () => {
    expect(target('')).toEqual({ ok: true, alias: 'sonnet', note: null });
    expect(target(undefined)).toEqual({ ok: true, alias: 'sonnet', note: null });
  });

  it('testing an unbound role tests the default and says which', () => {
    expect(target('dreaming')).toEqual({
      ok: true,
      alias: 'sonnet',
      note: 'unbound — testing the default, sonnet',
    });
    expect(markup('dreaming')).toContain('unbound — testing the default, sonnet');
  });

  it('testing the default role tests the registry default and does not call it unbound', () => {
    expect(target('default')).toEqual({ ok: true, alias: 'sonnet', note: null });
    expect(markup('default')).not.toContain('unbound');
    expect(target('default', registry({ default: null }))).toEqual({
      ok: false,
      reason: 'No default model is set, so there is nothing to test.',
    });
  });

  it('testing voice.model "Use default" tests the personality’s own model', () => {
    const inherit = classifyDeclaration('deep', data);
    expect(resolveTestTarget(classifyDeclaration('', data), data, inherit)).toEqual({
      ok: true,
      alias: 'opus',
      note: null,
    });
  });

  it('the button is disabled while no credential resolves, with the same reason as the option', () => {
    const bound = registry({
      roles: { trivial: 'gpt', default: null, deep: null, dreaming: null },
    });
    const option = modelDeclarationGroups(bound)[2]?.options.find((o) => o.value === 'gpt');
    const reason = missingCredentialReason('openai-main');
    expect(option?.hint).toBe(reason);
    expect(target('trivial', bound)).toEqual({ ok: false, reason });
    expect(target('gpt', bound)).toEqual({ ok: false, reason });

    const html = markup('trivial', bound);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Test/);
    expect(html).toContain(reason);
  });

  // The detail used to be a `flexBasis: 100%` child of the non-wrapping row, so
  // it took the row's width and squeezed the Select to a sliver. The row holds
  // the Select and Test only; every detail renders below it.
  it('keeps the Select and Test in one row and renders the detail below it', () => {
    const rowMarker = '<div style="display:flex;gap:8px;align-items:center">';
    const rowOf = (html: string) => {
      const start = html.indexOf(rowMarker);
      expect(start).toBeGreaterThanOrEqual(0);
      let depth = 0;
      const tags = /<div\b|<\/div>/g;
      tags.lastIndex = start;
      for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
        depth += tag[0] === '</div>' ? -1 : 1;
        if (depth === 0) return { row: html.slice(start, tags.lastIndex), end: tags.lastIndex };
      }
      throw new Error('unbalanced row');
    };

    const unbound = markup('dreaming');
    const note = 'unbound — testing the default, sonnet';
    const { row, end } = rowOf(unbound);
    expect(row).toContain('ant-select');
    expect(row).toMatch(/<button[^>]*>.*?Test/);
    expect(row).not.toContain(note);
    expect(row).not.toContain('flex-basis');
    expect(unbound.indexOf(note)).toBeGreaterThan(end);

    const reason = missingCredentialReason('openai-main');
    const noKey = markup(
      'trivial',
      registry({ roles: { trivial: 'gpt', default: null, deep: null, dreaming: null } }),
    );
    const disabled = rowOf(noKey);
    expect(disabled.row).toMatch(/<button[^>]*disabled=""[^>]*>.*?Test/);
    expect(disabled.row).not.toContain(reason);
    expect(noKey.indexOf(reason)).toBeGreaterThan(disabled.end);
  });

  it('is disabled when there is no default to test', () => {
    const none = registry({ default: null });
    expect(target('', none)).toEqual({
      ok: false,
      reason: 'No default model is set, so there is nothing to test.',
    });
  });
});
