import { MODEL_ROLE_NAMES, type ModelRoleName } from '@ethosagent/types';
import type { ModelRegistryListResult, ModelTierConfigWire } from '@ethosagent/web-contracts';

// A personality's `model` (and its `voice.model`) is a DECLARATION: a role name
// or a registry alias, resolved per turn by `resolveTurnModel`
// (packages/core/src/agent-loop/turn-model.ts). The picker offers exactly those
// two namespaces plus "Use default", so a vendor id cannot be typed in (plan
// model-registry D5). Pure helpers, so the option list and what Test resolves
// to are covered without rendering Antd.

/** The three fields of `modelRegistry.list` the picker reads. */
export type ModelRegistryView = Pick<ModelRegistryListResult, 'entries' | 'default' | 'roles'>;

/** A declared value as the personality RPCs carry it. */
export type DeclaredModel = string | ModelTierConfigWire | null | undefined;

/** Select value for "Use default" — sent as `''`, which clears the declaration. */
export const USE_DEFAULT = '';

export interface ModelDeclarationOption {
  value: string;
  /** The role or alias, rendered in Geist Mono. */
  name: string;
  /** Right-side hint: a binding, a label, or why the option is disabled. */
  hint: string;
  disabled: boolean;
}

export interface ModelDeclarationGroup {
  key: 'default' | 'roles' | 'models';
  label: string;
  options: ModelDeclarationOption[];
}

/** Why an alias cannot be chosen — the one reason an option is ever disabled (D16). */
export function missingCredentialReason(providerKey: string): string {
  return `${providerKey} has no API key`;
}

/**
 * Default, Roles, Models — in that order, every role and every alias, each
 * exactly once and in registry order. The ONLY thing that disables an option is
 * `credential === 'missing'`; nothing else in an entry is read for that.
 *
 * `defaultHint` overrides the "Use default" hint for a field whose default is
 * not the registry default (`voice.model` falls back to the personality's own
 * model).
 */
export function modelDeclarationGroups(
  registry: ModelRegistryView,
  defaultHint?: string,
): ModelDeclarationGroup[] {
  const fallback = registry.default ?? 'no default set';
  return [
    {
      key: 'default',
      label: 'Default',
      options: [
        {
          value: USE_DEFAULT,
          name: 'Use default',
          hint: defaultHint ?? fallback,
          disabled: false,
        },
      ],
    },
    {
      key: 'roles',
      label: 'Roles',
      options: MODEL_ROLE_NAMES.map((role) => {
        // The `default` role is never unbound: absent a hand-written
        // `modelRegistry.roles.default` (rung 4) it resolves to the registry
        // default (rung 5) — `resolveModel` in packages/core/src/model-resolution.ts.
        const isDefaultRole = role === 'default';
        const binding = registry.roles[role] ?? (isDefaultRole ? registry.default : null);
        return {
          value: role,
          name: role,
          hint: binding ? `→ ${binding}` : isDefaultRole ? fallback : `unbound, uses ${fallback}`,
          disabled: false,
        };
      }),
    },
    {
      key: 'models',
      label: 'Models',
      options: registry.entries.map((entry) => {
        const missing = entry.credential === 'missing';
        return {
          value: entry.alias,
          name: entry.alias,
          hint: missing
            ? missingCredentialReason(entry.providerKey)
            : (entry.label ?? entry.modelId),
          disabled: missing,
        };
      }),
    },
  ];
}

export type DeclarationState =
  | { kind: 'default' }
  | { kind: 'role'; role: ModelRoleName }
  | { kind: 'alias'; alias: string }
  /** A string that is neither a role nor an alias here — typically a vendor id. */
  | { kind: 'unknown'; value: string }
  | { kind: 'tierMap'; summary: string };

function isRole(value: string): value is ModelRoleName {
  return (MODEL_ROLE_NAMES as readonly string[]).includes(value);
}

/** What a stored declaration is, against this machine's registry. */
export function classifyDeclaration(
  declared: DeclaredModel,
  registry: ModelRegistryView,
): DeclarationState {
  if (declared === null || declared === undefined) return { kind: 'default' };
  if (typeof declared === 'object') {
    const summary = MODEL_ROLE_NAMES.flatMap((role) => {
      const leaf = (declared as Partial<Record<ModelRoleName, string>>)[role];
      return leaf ? [`${role}=${leaf}`] : [];
    }).join(', ');
    return summary ? { kind: 'tierMap', summary } : { kind: 'default' };
  }
  const value = declared.trim();
  if (value === '') return { kind: 'default' };
  if (isRole(value)) return { kind: 'role', role: value };
  if (registry.entries.some((e) => e.alias === value)) return { kind: 'alias', alias: value };
  return { kind: 'unknown', value };
}

/** The Select value for a state; `undefined` shows the placeholder (tier map). */
export function selectValueFor(state: DeclarationState): string | undefined {
  switch (state.kind) {
    case 'default':
      return USE_DEFAULT;
    case 'role':
      return state.role;
    case 'alias':
      return state.alias;
    case 'unknown':
      return state.value;
    case 'tierMap':
      return undefined;
  }
}

export function unknownDeclarationNote(value: string): string {
  return `${value} isn't a model on this machine — choose one from the list`;
}

export function tierMapNote(summary: string): string {
  return `Per-tier map: ${summary}. Choosing a value here replaces it; leaving this untouched keeps the map on save.`;
}

export type TestTarget =
  | { ok: true; alias: string; note: string | null }
  | { ok: false; reason: string };

function testableAlias(
  alias: string,
  registry: ModelRegistryView,
  note: string | null,
): TestTarget {
  const entry = registry.entries.find((e) => e.alias === alias);
  if (!entry) return { ok: false, reason: unknownDeclarationNote(alias) };
  if (entry.credential === 'missing') {
    return { ok: false, reason: missingCredentialReason(entry.providerKey) };
  }
  return { ok: true, alias, note };
}

function testDefault(registry: ModelRegistryView, note: string | null): TestTarget {
  if (!registry.default) {
    return { ok: false, reason: 'No default model is set, so there is nothing to test.' };
  }
  return testableAlias(registry.default, registry, note);
}

/**
 * The alias Test probes for a selection — what the selection RESOLVES TO now,
 * not the declared string: "Use default" → `modelRegistry.default`; a role →
 * its binding, or the default when unbound (the fall-through `resolveTurnModel`
 * takes); an alias → itself.
 *
 * `inherit` is what "Use default" means on a field that falls back to another
 * declaration instead of the registry default (`voice.model` → the
 * personality's own model).
 */
export function resolveTestTarget(
  state: DeclarationState,
  registry: ModelRegistryView,
  inherit?: DeclarationState,
): TestTarget {
  switch (state.kind) {
    case 'default':
      return inherit ? resolveTestTarget(inherit, registry) : testDefault(registry, null);
    case 'role': {
      const binding = registry.roles[state.role];
      if (binding) return testableAlias(binding, registry, null);
      // The `default` role resolves to the registry default — not a fall-through.
      if (state.role === 'default') return testDefault(registry, null);
      if (!registry.default) {
        return {
          ok: false,
          reason: `${state.role} is unbound and no default model is set, so there is nothing to test.`,
        };
      }
      return testDefault(registry, `unbound — testing the default, ${registry.default}`);
    }
    case 'alias':
      return testableAlias(state.alias, registry, null);
    case 'unknown':
      return { ok: false, reason: unknownDeclarationNote(state.value) };
    case 'tierMap':
      return {
        ok: false,
        reason: 'A per-tier map has no single model to test — choose a value to test it.',
      };
  }
}
