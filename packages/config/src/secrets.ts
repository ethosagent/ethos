import { detectSecrets } from '@ethosagent/safety-redact';
import { REF_TO_ENV } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import type { ProviderChainEntry } from './provider-chain';

// ---------------------------------------------------------------------------
// ${secrets:ref} substitution
// ---------------------------------------------------------------------------

const SECRETS_REF_RE = /\$\{secrets:([^}]+)\}/g;

export async function resolveSecretValue(value: string, secrets: SecretsResolver): Promise<string> {
  const matches = [...value.matchAll(SECRETS_REF_RE)];
  if (matches.length === 0) return value;
  let resolved = value;
  for (const m of matches) {
    const ref = m[1];
    if (!ref) continue;
    const secret = await secrets.get(ref);
    if (secret === null) {
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        throw new Error(
          `Secret not found: ${ref}\n\n` +
            `This secret can be provided by ANY of (highest precedence first):\n` +
            `  1. ~/.ethos/.env file with ${envKey}=<value>\n` +
            `  2. environment variable ${envKey}  (e.g. set by systemd EnvironmentFile, docker -e, or your shell)\n` +
            `  3. ~/.ethos/secrets/${ref}  (file mode 0600 — lowest-precedence fallback)\n\n` +
            `Run \`ethos secrets set ${ref} <value>\` to store it as the on-disk fallback.`,
        );
      }
      throw new Error(
        `Secret not found: ${ref}. Run 'ethos secrets set ${ref} <value>' to store it.`,
      );
    }
    resolved = resolved.replace(m[0], () => secret);
  }
  return resolved;
}

/**
 * Public single-value counterpart of `resolveConfigSecrets`, for surfaces that
 * hold one credential-bearing string rather than a whole `EthosConfig` (the
 * web's own config reader). Throws when a referenced secret is missing —
 * failing loudly beats handing a provider the literal reference string.
 */
export async function resolveSecretRef(value: string, secrets: SecretsResolver): Promise<string> {
  return resolveSecretValue(value, secrets);
}

// ---------------------------------------------------------------------------
// ${secrets:ref} externalization (write path)
// ---------------------------------------------------------------------------

/** True when `value` is ENTIRELY `${secrets:…}` reference(s) — i.e. it carries
 *  no literal credential material. */
export function isSecretRef(value: string): boolean {
  return value.replace(SECRETS_REF_RE, '').trim().length === 0;
}

export const SINGLE_SECRET_REF_RE = /^\$\{secrets:([^}]+)\}$/;

/**
 * The vault ref a stored config value points at, or `null` when it points at
 * none (a legacy plaintext value predating externalization never had material
 * stored, so there is nothing to delete).
 *
 * The read-back counterpart of `externalizeSecret`, and the ONE parser for the
 * `${secrets:…}` wire format on the removal path. Read the ref that was
 * WRITTEN — never re-derive one: ref names embed context the value alone does
 * not carry (provider name, bot key, content hash), and `externalizeSecret`'s
 * idempotent branch means a field keeps whatever ref it was first minted with.
 * Re-minting from what is on disk would name a ref the vault has never heard
 * of and orphan the real one.
 *
 * Deliberately strict: the whole value must be exactly one reference. A value
 * that merely CONTAINS a reference (`Bearer ${secrets:x}`) or concatenates
 * several yields `null`. Callers use this to decide which credential material
 * to DELETE, so a loose parse deletes material something else still needs.
 */
export function secretRefFromValue(value: string): string | null {
  return value.match(SINGLE_SECRET_REF_RE)?.[1] ?? null;
}

/**
 * Store a credential in the vault and return the `${secrets:<ref>}` reference
 * that belongs in config.yaml. This is the ONLY way a credential-bearing field
 * reaches disk (G-SEC / ARCHITECTURE.md §V S9 — config references a secret by
 * name, never by value).
 *
 * Idempotent: a value that is ALREADY a reference is returned untouched.
 * Re-wrapping would corrupt the config and orphan the stored secret, so that
 * branch is the load-bearing one on every rewrite of an existing config.
 * Empty / undefined values are returned unchanged — there is nothing to store.
 */
export async function externalizeSecret(
  value: string,
  ref: string,
  secrets: SecretsResolver,
): Promise<string>;
export async function externalizeSecret(
  value: string | undefined,
  ref: string,
  secrets: SecretsResolver,
): Promise<string | undefined>;
export async function externalizeSecret(
  value: string | undefined,
  ref: string,
  secrets: SecretsResolver,
): Promise<string | undefined> {
  if (value === undefined || value === '') return value;
  if (isSecretRef(value)) return value;
  await secrets.set(ref, value);
  return `\${secrets:${ref}}`;
}

/** Context `secretRefForConfigKey` needs for the keys whose ref embeds a value
 *  from elsewhere in the config. */
export interface SecretRefContext {
  /** The `provider:` value — names the ref for the top-level `apiKey`. */
  provider?: string;
  /** Provider-chain names by index. `providers.<n>.apiKey` refs embed the
   *  provider name, matching what `ethos fallback add` already mints. */
  providerChain?: readonly string[];
  /** Stable botKey per `telegram.bots.<n>` — `deriveBotKey(bot)`. Keys the
   *  ref by identity rather than array position, matching what the web
   *  Communications tab (PlatformsRepository) already mints. Falls back to
   *  the index when the caller can't supply one. */
  telegramBotKeys?: readonly (string | undefined)[];
  /** Stable botKey per `slack.apps.<n>` — see `telegramBotKeys`. */
  slackAppKeys?: readonly (string | undefined)[];
  /** Stable identity per rotation key in `~/.ethos/keys.json` —
   *  `rotationKeyId(profile)`. See `telegramBotKeys`. */
  rotationKeyIds?: readonly (string | undefined)[];
}

/** Flat key → ref, for keys whose ref name doesn't follow from the key path. */
const STATIC_SECRET_REFS: Record<string, string> = {
  telegramToken: 'telegram/token',
  discordToken: 'discord/token',
  slackBotToken: 'slack/botToken',
  slackAppToken: 'slack/appToken',
  slackSigningSecret: 'slack/signingSecret',
  emailPassword: 'email/password',
};

/** Indexed key families. The ref is keyed by the entry's stable botKey when the
 *  caller supplies one, so reordering the array can't point two entries at one
 *  ref; the array index is the fallback. */
const INDEXED_SECRET_REFS: ReadonlyArray<{
  re: RegExp;
  ref: (m: RegExpMatchArray, ctx: SecretRefContext) => string;
}> = [
  {
    // `webhookSecretToken` rides the same rule as `token` so it is keyed by the
    // bot's stable botKey too — the catch-all below would key it by array index
    // instead, and reordering the roster would then point two bots at one ref.
    re: /^telegram\.bots\.(\d+)\.(token|webhookSecretToken)$/,
    ref: (m, ctx) => `telegram/bots/${ctx.telegramBotKeys?.[Number(m[1])] ?? m[1]}/${m[2]}`,
  },
  {
    re: /^slack\.apps\.(\d+)\.(botToken|appToken|signingSecret)$/,
    ref: (m, ctx) => `slack/apps/${ctx.slackAppKeys?.[Number(m[1])] ?? m[1]}/${m[2]}`,
  },
  {
    // `~/.ethos/keys.json`, not config.yaml — the rotation pool is a second
    // file through the same ref minter. `rotation/` is the prefix `ethos keys`
    // has always used, so it can't collide with the `providers/…` refs above.
    re: /^keys\.(\d+)\.apiKey$/,
    ref: (m, ctx) => `rotation/${ctx.rotationKeyIds?.[Number(m[1])] ?? m[1]}`,
  },
  {
    // Every OTLP collector header VALUE is a credential (otlp-export D7); the
    // header NAME keys the ref. Greedy `.+` so a header name containing a dot
    // survives intact rather than being split by the dot-to-slash catch-all.
    re: /^telemetry\.export\.otlp\.headers\.(.+)$/,
    ref: (m) => `telemetry/export/otlp/headers/${m[1]}`,
  },
];

/** Credential leaves `SECRET_FIELD_NAMES` doesn't list (it catches these by
 *  regex instead). The write path can't rely on a regex — it must externalize
 *  them by name. */
const EXTRA_SECRET_LEAVES = new Set(['apiSecret', 'secret', 'previousSecret']);

/**
 * Map a flat config key (`apiKey`, `telegram.bots.0.token`, `webhooks.x.secret`)
 * to the vault ref its value belongs at, or `null` when the key carries no
 * credential.
 *
 * The single ref-naming scheme: both config serializers — `writeConfig` here
 * and `ConfigRepository` in apps/web-api — go through it, so a rewrite from
 * either surface lands on the same ref instead of minting a second one and
 * orphaning the first.
 */
export function secretRefForConfigKey(key: string, ctx: SecretRefContext = {}): string | null {
  // `toolSettings.<id>.web_search.secret` is a secret NAME, not a value
  // (WebSearchToolSetting) — externalizing it would break the binding.
  if (key.startsWith('toolSettings.')) return null;
  if (key === 'apiKey') return `providers/${ctx.provider ?? 'default'}/apiKey`;
  const chain = key.match(/^providers\.(\d+)\.apiKey$/);
  if (chain?.[1] !== undefined) {
    const name = ctx.providerChain?.[Number(chain[1])];
    return name ? `providers/${chain[1]}/${name}/apiKey` : `providers/${chain[1]}/apiKey`;
  }
  const staticRef = STATIC_SECRET_REFS[key];
  if (staticRef) return staticRef;
  for (const rule of INDEXED_SECRET_REFS) {
    const m = key.match(rule.re);
    if (m) return rule.ref(m, ctx);
  }
  // Catch-all: any other key whose LEAF names a credential field. Keeps keys
  // this table doesn't enumerate (notably apps/web-api's passthrough block,
  // which round-trips keys it never models) from reaching disk in plaintext.
  // `auxiliary.tts.apiKey` → `auxiliary/tts/apiKey`.
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (SECRET_FIELD_NAMES.has(leaf) || EXTRA_SECRET_LEAVES.has(leaf)) {
    return key.replace(/\./g, '/');
  }
  return null;
}

/**
 * Write-path externalization for the whole provider chain: every entry's
 * `apiKey`, and every `passthrough` field whose name `secretRefForConfigKey`
 * maps to a ref, goes to the vault. Both config writers call it
 * (`externalizeConfigSecrets` here, `ConfigRepository` in apps/web-api), so no
 * chain credential reaches disk as a value.
 *
 * Vault names embed an index (`providers/1/bedrock/apiKey`), and a stored
 * value is already a reference, which passes through untouched — so an entry
 * keeps the name it was FIRST stored under when it moves. A newly typed value
 * is therefore stored under a name no value in the resulting chain references:
 * the derived name, or its first free `-2`, `-3`, … suffix. Without that, a key
 * typed for the entry that takes a vacated index overwrote the secret of the
 * entry that moved away from it. Pinned by
 * `__tests__/config-provider-chain.test.ts` ("vacated index").
 *
 * `reserved` holds the values of the config's OTHER credential lines — each
 * writer passes its top-level `apiKey` (and, in apps/web-api, the voice keys
 * and passthrough), because a provider move writes chain entry 0's
 * index-named reference into the top-level `apiKey` line (`ConfigService`),
 * and a name counted as free there would be minted again over that key.
 * Pinned by `__tests__/config-provider-chain.test.ts` ("counts the top-level
 * key as taken") and apps/ethos's `fallback-secrets.test.ts`.
 */
export async function externalizeProviderChain<E extends ProviderChainEntry>(
  entries: readonly E[],
  secrets: SecretsResolver,
  reserved: Iterable<string | undefined> = [],
): Promise<E[]> {
  const ctx: SecretRefContext = { providerChain: entries.map((p) => p.provider) };
  const taken = new Set<string>();
  const values: Array<string | undefined> = [...reserved];
  for (const entry of entries) values.push(entry.apiKey, ...Object.values(entry.passthrough ?? {}));
  for (const value of values) {
    for (const m of (value ?? '').matchAll(SECRETS_REF_RE)) if (m[1]) taken.add(m[1]);
  }
  const store = async (value: string, key: string): Promise<string> => {
    const base = secretRefForConfigKey(key, ctx);
    if (!value || isSecretRef(value) || base === null) return value;
    let ref = base;
    for (let n = 2; taken.has(ref); n++) ref = `${base}-${n}`;
    taken.add(ref);
    return externalizeSecret(value, ref, secrets);
  };
  const out: E[] = [];
  for (const [i, entry] of entries.entries()) {
    const next: E = { ...entry };
    if (entry.apiKey) next.apiKey = await store(entry.apiKey, `providers.${i}.apiKey`);
    if (entry.passthrough) {
      const passthrough: Record<string, string> = {};
      for (const [field, value] of Object.entries(entry.passthrough)) {
        passthrough[field] = await store(value, `providers.${i}.${field}`);
      }
      next.passthrough = passthrough;
    }
    out.push(next);
  }
  return out;
}

/**
 * Whether `ref` is a vault name the provider-chain writers mint:
 * `providers/<index>/…` (`secretRefForConfigKey` on a `providers.<n>.*` key,
 * plus `externalizeProviderChain`'s `-2`, `-3`, … suffixes). These are the ONLY
 * secrets a config write may delete as orphans. Every other name is read by
 * name, with no `${secrets:…}` line anywhere: the canonical
 * `providers/<provider>/<field>` names (`secrets.get` in llm-anthropic,
 * llm-openai-compat, llm-azure, llm-bedrock, llm-gemini and apps/web-api's
 * named-secrets service; the declared secret of tools-image and the default
 * ref of tools-answer-engines' ChatGPT engine) and the `auxiliary/*` ones — so
 * config.yaml not naming one says nothing about whether it is in use. No
 * by-name reader uses a numeric second segment.
 */
export function isProviderChainSecretRef(ref: string): boolean {
  return /^providers\/\d+\//.test(ref);
}

// ---------------------------------------------------------------------------
// Plaintext secret detection
// ---------------------------------------------------------------------------

/**
 * Fields whose values MUST be entirely `${secrets:ref}` references when a
 * SecretsResolver is configured. These are known credential-bearing fields
 * regardless of whether the value matches a regex pattern.
 */
const SECRET_FIELD_NAMES = new Set([
  'apiKey',
  'token',
  'botToken',
  'appToken',
  'signingSecret',
  'password',
  'webhookSecret',
  'webhookSecretToken',
  'emailPassword',
  'discordToken',
  'slackBotToken',
  'slackAppToken',
  'slackSigningSecret',
  'telegramToken',
  'secretKey',
]);

/** `telemetry.export.otlp.headers.<Name>` — every value under this path must
 *  be a `${secrets:…}` reference (otlp-export D7). Path-keyed rather than
 *  leaf-keyed because the leaf is the operator's header name. */
const OTLP_HEADER_FIELD_RE = /^telemetry\.export\.otlp\.headers\./;

/**
 * Walk every string value in `config` (including nested objects and arrays)
 * and throw if any value looks like a plaintext secret. Called from
 * `loadConfigStrict` *before* secrets resolution, so legitimate
 * `${secrets:ref}` references are still present and are explicitly skipped.
 *
 * Two-pass check:
 * 1. **Field-name check** — if the leaf field name is in SECRET_FIELD_NAMES,
 *    the ENTIRE value must be a secrets reference.
 * 2. **Regex catch-all** — for all other fields, run `detectSecrets`.
 *
 * Skips validation entirely when no SecretsResolver is configured (local dev
 * without secrets infrastructure).
 *
 * The check is purely structural, so the parameter is any on-disk object
 * graph, not only `EthosConfig` — `writeKeys` runs the same gate over
 * `~/.ethos/keys.json`.
 */
export function validateNoPlaintextSecrets(config: object): void {
  const violations: Array<{ field: string; label: string }> = [];
  walkStringValues(config, '', (field, value) => {
    const stripped = value.replace(SECRETS_REF_RE, '');
    if (stripped.length === 0) return;

    // Extract the leaf field name, stripping trailing array indices
    const raw = field.includes('.') ? field.slice(field.lastIndexOf('.') + 1) : field;
    const leaf = raw.replace(/\[\d+\]$/, '');

    // Every OTLP collector header value is a credential (otlp-export D7):
    // the leaf is the header NAME, so the path — not the field name — is
    // what marks it secret.
    if (SECRET_FIELD_NAMES.has(leaf) || OTLP_HEADER_FIELD_RE.test(field)) {
      // Known secret field — entire value must be a secrets reference
      if (stripped.trim().length > 0) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal label, not a template
        violations.push({ field, label: 'secret (field requires ${secrets:ref})' });
      }
      return;
    }

    const detections = detectSecrets(stripped);
    if (detections.length > 0) {
      violations.push({ field, label: detections[0].label });
    }
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `  - field '${v.field}' appears to contain a plaintext ${v.label}. ` +
          `Use \${secrets:<ref>} substitution instead.${providerLineFix(v.field)}`,
      )
      .join('\n');
    throw new Error(`Config validation failed: plaintext secret(s) detected.\n${details}`);
  }
}

/**
 * The concrete fix for a violation inside the provider chain, whose object
 * path (`providers[1].passthrough.awsAccessKeyId`) is not the config.yaml line
 * an operator has to edit (`providers.1.awsAccessKeyId`). An unmodelled chain
 * field used to be dropped on read, so a config carrying a key in one booted
 * before and is refused now; this names the line and the command. Empty for
 * any other path, whose object path and config key need no translation or
 * are not config.yaml at all (`writeKeys`'s `[0].apiKey`). Pinned by
 * `__tests__/config-provider-chain.test.ts` ("plaintext secret").
 */
function providerLineFix(field: string): string {
  const m = field.match(/^providers\[(\d+)\]\.(?:passthrough\.)?(.+)$/);
  if (!m) return '';
  const key = `providers.${m[1]}.${m[2]}`;
  const ref = secretRefForConfigKey(key) ?? key.replace(/\./g, '/');
  return (
    ` It is config.yaml line \`${key}\`: run \`ethos secrets set ${ref} <value>\`, ` +
    `then change the line to \`${key}: \${secrets:${ref}}\`.`
  );
}

function walkStringValues(
  obj: unknown,
  prefix: string,
  cb: (field: string, value: string) => void,
): void {
  if (typeof obj === 'string') {
    cb(prefix, obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      walkStringValues(obj[i], `${prefix}[${i}]`, cb);
    }
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      walkStringValues(value, prefix ? `${prefix}.${key}` : key, cb);
    }
  }
}
