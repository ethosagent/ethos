import { describe, expect, it } from 'vitest';
import { ApiKeyMetadataSchema, ApiKeyScopeSchema, ApiKeyStaticScopeSchema } from '../index';

// Regression guard for the two-mint-paths split.
//
// `/v1/*` asserts the literal scope `chat`. `ApiKeyScopeSchema` did not list
// it, so the two mint paths produced mutually exclusive key populations:
//
//   `ethos api-key create`  → wrote `['chat']` straight into SQLite (the store
//                             does no scope validation) → worked on `/v1/*`.
//   `apiKeys.create` RPC    → `z.array(ApiKeyScopeSchema)` rejected `'chat'`
//                             → the web UI could never mint a working key.
//
// The output half broke too: `apiKeys.list` validates against
// `ApiKeyMetadataSchema`, so a CLI-minted key was unrenderable in the web UI.

describe('ApiKeyScopeSchema — `chat` is mintable through both paths', () => {
  it('accepts `chat`, the scope `/v1/*` asserts', () => {
    expect(ApiKeyScopeSchema.safeParse('chat').success).toBe(true);
  });

  it('validates a web-UI create payload scoped to `chat`', () => {
    // Mirrors ApiKeyCreateInput.scopes in ../router — `z.array(ApiKeyScopeSchema)`.
    const parsed = ApiKeyScopeSchema.array().min(1).safeParse(['chat']);
    expect(parsed.success).toBe(true);
  });

  it('round-trips a CLI-minted `chat` key through ApiKeyMetadataSchema', () => {
    const parsed = ApiKeyMetadataSchema.safeParse({
      id: 'key_1',
      prefix: 'sk-ethos-abc',
      name: 'cursor',
      scopes: ['chat'],
      allowedOrigins: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      revokedAt: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps `chat` and `chat:send` as distinct members', () => {
    expect(ApiKeyStaticScopeSchema.options).toContain('chat');
    expect(ApiKeyStaticScopeSchema.options).toContain('chat:send');
  });

  it('still rejects a scope that is not in the enum', () => {
    expect(ApiKeyScopeSchema.safeParse('completions').success).toBe(false);
  });
});

// D17 (analytics-observability plan, P2-counters) — `metrics:read` gates the
// `/metrics` mount on both web-api and the gateway health server.
describe('ApiKeyScopeSchema — `metrics:read`', () => {
  it('accepts `metrics:read`, the scope `/metrics` asserts', () => {
    expect(ApiKeyScopeSchema.safeParse('metrics:read').success).toBe(true);
  });

  it('round-trips a CLI-minted `metrics:read` key through ApiKeyMetadataSchema', () => {
    const parsed = ApiKeyMetadataSchema.safeParse({
      id: 'key_2',
      prefix: 'sk-ethos-def',
      name: 'prometheus',
      scopes: ['metrics:read'],
      allowedOrigins: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      revokedAt: null,
    });
    expect(parsed.success).toBe(true);
  });
});

// M-T4 (trust-before-reach, Part 3) — `mcp:<personality-id>` scopes one API key
// to exactly one exported personality. It is the first OPEN-ENDED member of the
// vocabulary, so `ApiKeyScopeSchema` is a union rather than an enum, and the
// enum half lives on separately as `ApiKeyStaticScopeSchema` because `.options`
// (what the CLI prints and what the SCOPE_MAP drift test enumerates) has no
// union equivalent.
//
// The charset is not decoration: the id half names a personality a host
// resolves, so anything that could escape a directory must not parse. The
// pattern is SAFE_ID_REGEX from `packages/types/src/id-validation.ts`, copied
// because this package cannot import `@ethosagent/types` (ARCHITECTURE.md
// Law 1); the two must change together.
describe('ApiKeyScopeSchema — `mcp:<personality-id>`', () => {
  it('accepts a well-formed export scope', () => {
    expect(ApiKeyScopeSchema.safeParse('mcp:reviewer').success).toBe(true);
  });

  it('accepts the full safe-id charset (digits, hyphens, underscores)', () => {
    for (const id of ['mcp:a', 'mcp:7', 'mcp:code-reviewer', 'mcp:code_reviewer_2']) {
      expect(ApiKeyScopeSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rejects a traversal-shaped id', () => {
    expect(ApiKeyScopeSchema.safeParse('mcp:../x').success).toBe(false);
  });

  it('rejects every other unsafe id shape', () => {
    for (const bad of [
      'mcp:', // empty id
      'mcp:/etc/passwd', // path separator
      'mcp:Reviewer', // uppercase
      'mcp:-leading-hyphen', // must start alphanumeric
      'mcp:a b', // space
      'mcp:a.b', // dot
      'mcp:a:b', // second colon
      ' mcp:reviewer', // leading whitespace
      'mcp:reviewer\n', // trailing newline — `$` alone would let this through
      'xmcp:reviewer', // prefix must be exact
    ]) {
      expect(ApiKeyScopeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('still rejects a bare unknown scope', () => {
    // The union widened what parses; it must not have widened it to anything.
    expect(ApiKeyScopeSchema.safeParse('completions').success).toBe(false);
    expect(ApiKeyScopeSchema.safeParse('mcp').success).toBe(false);
  });

  it('keeps `mcp:` out of the static enum', () => {
    expect(ApiKeyStaticScopeSchema.safeParse('mcp:reviewer').success).toBe(false);
    expect(ApiKeyStaticScopeSchema.options).not.toContain('mcp:reviewer');
  });

  it('validates a web-UI create payload scoped to one export', () => {
    // Mirrors ApiKeyCreateInput.scopes in ../router — `z.array(ApiKeyScopeSchema)`.
    const parsed = ApiKeyScopeSchema.array().min(1).safeParse(['mcp:reviewer']);
    expect(parsed.success).toBe(true);
  });

  it('round-trips an `mcp:` key through ApiKeyMetadataSchema', () => {
    const parsed = ApiKeyMetadataSchema.safeParse({
      id: 'key_3',
      prefix: 'sk-ethos-ghi',
      name: 'reviewer-export',
      scopes: ['mcp:reviewer'],
      allowedOrigins: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      revokedAt: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a metadata row carrying a malformed export scope', () => {
    const parsed = ApiKeyMetadataSchema.safeParse({
      id: 'key_4',
      prefix: 'sk-ethos-jkl',
      name: 'bad',
      scopes: ['mcp:../x'],
      allowedOrigins: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      revokedAt: null,
    });
    expect(parsed.success).toBe(false);
  });
});
