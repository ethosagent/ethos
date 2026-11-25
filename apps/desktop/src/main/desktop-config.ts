import { join } from 'node:path';
import { assertWritableConfigLines, readConfig, renderConfigScalar } from '@ethosagent/config';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { getDefaultModel } from '@ethosagent/wiring/model-catalog';

/**
 * The model fields the desktop backend's `WiringConfig` and `chatDefaults`
 * take. Each is set only when `<dataDir>/config.yaml` carries its key, so the
 * caller can fall back per field (`resolveDesktopModelSettings`).
 */
export interface SharedModelSettings {
  provider?: string;
  model?: string;
  personality?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** The same fields as the Electron store holds them (./store.ts). */
export interface StoredModelSettings {
  provider?: string;
  model?: string;
  personality?: string;
  baseUrl?: string;
}

export interface DesktopModelSettings {
  provider: string;
  model: string;
  personality: string;
  apiKey: string;
  baseUrl?: string;
}

/** `${secrets:api-key}` — the ref the onboarding handler has always written. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML secrets ref, not a JS template
const API_KEY_REF = '${secrets:api-key}';

/** The `key` of a flat `key: value` line; `null` for blanks and comments. Same rule as `configLineKey` in packages/config/src/scalar.ts. */
function lineKey(line: string): string | null {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const key = line.slice(0, i);
  if (key.startsWith('#') || /\s/.test(key)) return null;
  return key;
}

/**
 * provider / model / personality / apiKey / baseUrl from `<dir>/config.yaml` —
 * the file the SPA's onboarding (`ConfigRepository.update`, apps/web-api) and
 * the onboarding IPC (`mergeOnboardingIntoConfig`) write, and the web header
 * reads. Values come from `readConfig`, the CLI's parser with `${secrets:...}`
 * refs resolved through `secrets` (as `loadConfig` → `wiringConfigFor` in
 * apps/ethos/src/wiring.ts spreads them). The parser fills absent keys with
 * defaults, so a field is returned only when its key is a line in the file.
 * `{}` when the file is absent. Pinned by __tests__/desktop-config.test.ts.
 */
export async function readSharedModelSettings(
  storage: Storage,
  secrets: SecretsResolver,
  dir: string,
): Promise<SharedModelSettings> {
  const config = await readConfig(storage, secrets, { dir });
  if (!config) return {};
  const src = (await storage.read(join(dir, 'config.yaml'))) ?? '';
  const keys = new Set(src.split('\n').map(lineKey));
  return {
    ...(keys.has('provider') ? { provider: config.provider } : {}),
    ...(keys.has('model') ? { model: config.model } : {}),
    ...(keys.has('personality') ? { personality: config.personality } : {}),
    ...(keys.has('apiKey') && config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(keys.has('baseUrl') && config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

/**
 * Per field: config.yaml, then the Electron store, then the desktop's
 * long-standing default (`anthropic`, its catalog default model, `operator`).
 * `apiKey` falls back to the keychain value, then `''` — what the CLI passes
 * when config.yaml has no key (`apiKey: kv.apiKey ?? ''`, parseConfigYaml);
 * OAuth providers such as codex read their tokens from the secrets resolver
 * and ignore it. Pinned by __tests__/desktop-config.test.ts.
 */
export function resolveDesktopModelSettings(
  shared: SharedModelSettings,
  stored: StoredModelSettings,
  keychainApiKey: string | null,
): DesktopModelSettings {
  const baseUrl = shared.baseUrl ?? stored.baseUrl;
  return {
    provider: shared.provider ?? stored.provider ?? 'anthropic',
    model:
      shared.model ?? stored.model ?? getDefaultModel('anthropic')?.modelId ?? 'claude-opus-5-5',
    personality: shared.personality ?? stored.personality ?? 'operator',
    apiKey: shared.apiKey ?? keychainApiKey ?? '',
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Sets provider / model / personality (and `apiKey: ${secrets:api-key}` when
 * `apiKeyRef`) in `<dataDir>/config.yaml`, line by line: every other line —
 * channels, mcp, nodes, comments — stays where it was. A file with no
 * `schemaVersion` gets `schemaVersion: 1` on top, so a missing file is created
 * with exactly the five lines the handler wrote before. Atomic, mode 0600,
 * the way packages/config rewrites the file (`migrateActiveContextPersonality`,
 * io.ts). Pinned by __tests__/desktop-config.test.ts and
 * __tests__/onboarding-complete-remote.test.ts.
 */
export async function mergeOnboardingIntoConfig(
  target: { storage: Storage; dataDir: string },
  input: { provider: string; model: string; personality: string; apiKeyRef: boolean },
): Promise<void> {
  const { storage, dataDir } = target;
  const path = join(dataDir, 'config.yaml');
  const updates = new Map<string, string>([
    ['provider', input.provider],
    ['model', input.model],
    ['personality', input.personality],
    ...(input.apiKeyRef ? [['apiKey', API_KEY_REF] as const] : []),
  ]);
  const existing = await storage.read(path);
  const lines = existing ? existing.replace(/\n+$/, '').split('\n') : [];
  const written = new Set<string>();
  const out = lines.map((line) => {
    const key = lineKey(line);
    const value = key === null ? undefined : updates.get(key);
    if (key === null || value === undefined) return line;
    written.add(key);
    return `${key}: ${renderConfigScalar(value)}`;
  });
  for (const [key, value] of updates) {
    if (!written.has(key)) out.push(`${key}: ${renderConfigScalar(value)}`);
  }
  if (!lines.some((line) => lineKey(line) === 'schemaVersion')) out.unshift('schemaVersion: 1');
  assertWritableConfigLines(out);
  await storage.mkdir(dataDir);
  await storage.writeAtomic(path, `${out.join('\n')}\n`, { mode: 0o600 });
}
