import { SECRET_NAME_RE, type Tool, type ToolRegistry } from '@ethosagent/types';

// The provider roster, derived (plan/phases/tool-credential-surface.md D1–D2).
//
// A credential namespace exists because a registered tool declares it — not
// because someone remembered to add a value to an enum in
// `packages/web-contracts`. The union of every `providers/<segment>/*` prefix
// in `capabilities.secrets` IS the set of namespaces an operator may type a
// credential into, which is what lets a PLUGIN's tool ship a credential surface
// at all: a plugin cannot extend a zod enum in this repository.
//
// This lives in `apps/web-api` because it needs both halves — the tool registry
// (assembled in wiring, injected here) and the vault service that consumes the
// roster. `extensions/` cannot see the registry, so nothing lower can hold it.
//
// D13, stated once so it cannot be blurred: this decides who may CREATE a value
// in a namespace. `ScopedSecretsImpl.isDeclared`
// (`packages/core/src/scoped/scoped-secrets.ts`) decides who may READ one, and
// is untouched.

export interface DerivedProvider {
  /** The `<segment>` of `providers/<segment>/*` — a single safe path segment. */
  provider: string;
  /** Every `secretKind` declared by a tool that grants this namespace. */
  kinds: string[];
  /** Human name for the add-secret form; the provider id when none was given. */
  label: string;
  getKeyUrl?: string;
}

export interface ProviderDiagnostic {
  toolName: string;
  declared: string;
  reason: string;
}

export interface DerivedProviderRoster {
  providers: DerivedProvider[];
  diagnostics: ProviderDiagnostic[];
}

/**
 * Providers no shipped tool declares, kept so an operator who already stored a
 * value under one keeps seeing and editing it (D14). `x` is the whole list: an
 * X API bearer token for the native X search backend, which is planned and not
 * built, so nothing declares `providers/x/*`. Its kind and label are the ones
 * the deleted `NAMED_SECRET_PROVIDERS` row carried, so the picker filter that
 * resolved them before still resolves them.
 *
 * A seed entry is a FALLBACK: a tool declaring the same provider wins on label
 * and unions its kinds in.
 */
export const NAMED_SECRET_SEED_PROVIDERS: readonly DerivedProvider[] = [
  {
    provider: 'x',
    kinds: ['x-api'],
    label: 'X API (bearer token)',
    getKeyUrl: 'https://developer.x.com/en/portal/dashboard',
  },
];

/**
 * Derive the manageable provider namespaces from the registered tools.
 *
 * A declaration contributes a provider only when it is exactly
 * `providers/<segment>/*` with `<segment>` matching `SECRET_NAME_RE`. A grant
 * that names an EXACT ref (`providers/exa/apiKey`) is a specific credential
 * rather than a namespace someone can add names under, so it contributes
 * nothing and is not reported — three shipped tools do this deliberately
 * (§7.4). A grant that is prefix-SHAPED but malformed contributes nothing and
 * is reported as a diagnostic, because that one is a mistake.
 *
 * Presentation, per provider, first declaration wins in registry order:
 *   1. an `enum` option label / getKeyUrl whose value is the provider id —
 *      per-provider, and the precedent `RecipesService.secretSchemaFor`
 *      already reads for labels;
 *   2. the tool's `secret-binding` `providerLabel` / `getKeyUrl` (D4);
 *   3. the provider id itself (label only).
 */
export function deriveProviderRoster(
  registry: Pick<ToolRegistry, 'getAvailable'> | undefined,
  seed: readonly DerivedProvider[] = [],
): DerivedProviderRoster {
  const byProvider = new Map<string, { kinds: Set<string>; label?: string; getKeyUrl?: string }>();
  const diagnostics: ProviderDiagnostic[] = [];

  for (const tool of registry?.getAvailable() ?? []) {
    const fields = tool.settingsSchema?.fields ?? [];
    const bindings = fields.filter((f) => f.kind === 'secret-binding');
    const optionLabels = enumOptionLabels(tool);
    const optionUrls = enumOptionUrls(tool);
    const kinds = bindings.map((f) => f.secretKind);
    const providerLabel = bindings.find((f) => f.providerLabel)?.providerLabel;
    const bindingGetKeyUrl = bindings.find((f) => f.getKeyUrl)?.getKeyUrl;

    for (const declared of tool.capabilities?.secrets ?? []) {
      if (!declared.endsWith('/*')) continue;
      const segments = declared.slice(0, -2).split('/');
      const provider = segments[1];
      if (segments.length !== 2 || segments[0] !== 'providers' || !provider) {
        diagnostics.push(malformed(tool.name, declared));
        continue;
      }
      if (!SECRET_NAME_RE.test(provider)) {
        diagnostics.push(malformed(tool.name, declared));
        continue;
      }
      const entry = byProvider.get(provider) ?? { kinds: new Set<string>() };
      for (const kind of kinds) entry.kinds.add(kind);
      entry.label ??= optionLabels.get(provider) ?? providerLabel;
      entry.getKeyUrl ??= optionUrls.get(provider) ?? bindingGetKeyUrl;
      byProvider.set(provider, entry);
    }
  }

  for (const entry of seed) {
    const existing = byProvider.get(entry.provider);
    if (existing) {
      for (const kind of entry.kinds) existing.kinds.add(kind);
      existing.label ??= entry.label;
      existing.getKeyUrl ??= entry.getKeyUrl;
      continue;
    }
    byProvider.set(entry.provider, {
      kinds: new Set(entry.kinds),
      label: entry.label,
      ...(entry.getKeyUrl ? { getKeyUrl: entry.getKeyUrl } : {}),
    });
  }

  const providers = [...byProvider.entries()]
    .map(([provider, e]) => ({
      provider,
      kinds: [...e.kinds].sort(),
      label: e.label ?? provider,
      ...(e.getKeyUrl ? { getKeyUrl: e.getKeyUrl } : {}),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  return { providers, diagnostics };
}

/** Option value → label from the tool's `enum` field, when it has one. This is
 *  how a multi-provider tool (`web_search`: Exa / Tavily / Brave) labels each
 *  namespace separately — one `providerLabel` could not. */
function enumOptionLabels(tool: Tool): Map<string, string> {
  const labels = new Map<string, string>();
  for (const field of tool.settingsSchema?.fields ?? []) {
    if (field.kind !== 'enum') continue;
    for (const option of field.options) {
      if (option.label) labels.set(option.value, option.label);
    }
  }
  return labels;
}

/** Option value → getKeyUrl from the tool's `enum` field — same per-provider
 *  seam as `enumOptionLabels`, for tools whose one secret-binding covers
 *  several namespaces. */
function enumOptionUrls(tool: Tool): Map<string, string> {
  const urls = new Map<string, string>();
  for (const field of tool.settingsSchema?.fields ?? []) {
    if (field.kind !== 'enum') continue;
    for (const option of field.options) {
      if (option.getKeyUrl) urls.set(option.value, option.getKeyUrl);
    }
  }
  return urls;
}

function malformed(toolName: string, declared: string): ProviderDiagnostic {
  return {
    toolName,
    declared,
    reason: `Tool "${toolName}" declares secret prefix "${declared}", which does not match providers/<segment>/* — it grants nothing manageable.`,
  };
}
