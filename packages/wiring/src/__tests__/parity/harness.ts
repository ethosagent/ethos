// Phase 0 parity harness (plan codebase-slimming §2.4). One compare path for every
// snapshot: `assertParity(name, value)` serialises `value` as canonical JSON and
// compares it byte-for-byte with `golden/<name>.json`.
//
// Unlike `helpers/golden-request-harness.ts`, a MISSING fixture FAILS. Deleting a
// fixture must never re-baseline a parity gate. Regenerate only on purpose:
//   UPDATE_PARITY=1 pnpm vitest run packages/wiring/src/__tests__/parity
// and commit the regenerated JSON in the same PR as the code that changed it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { expect, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = join(HERE, 'golden');
export const PARITY_DIR = HERE;
export const REPO_ROOT = join(HERE, '../../../../..');

export const updating = (): boolean => process.env.UPDATE_PARITY === '1';

/** Keys sorted at every depth; `undefined` object members dropped (as JSON does). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value !== null && typeof value === 'object') {
    // A Map, Set, Date or class instance would serialise to `{}` and hide its content.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `canonicalize: non-plain object (${value.constructor?.name ?? 'unknown'}); convert it to plain data first`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: sorted keys, 2-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

export interface AssertParityOptions {
  /** Called under `UPDATE_PARITY=1` with the existing fixture (parsed) and the new
   *  value, before anything is written. Throw to refuse the update (P5). */
  guardUpdate?: (existing: unknown, next: unknown) => void;
  /** Under `UPDATE_PARITY=1`, throw when the fixture does not exist, so a deleted
   *  fixture cannot be re-baselined past `guardUpdate` (P5). */
  requireExistingFixture?: boolean;
}

export function assertParity(name: string, value: unknown, opts: AssertParityOptions = {}): void {
  const path = goldenPath(name);
  const actual = canonicalJson(value);
  if (updating()) {
    const exists = existsSync(path);
    if (!exists && opts.requireExistingFixture) {
      throw new Error(
        `parity fixture missing: ${path}. This gate refuses to re-baseline from nothing; ` +
          'restore the fixture from git and update it from there.',
      );
    }
    if (opts.guardUpdate && exists) {
      opts.guardUpdate(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(actual));
    }
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `parity fixture missing: ${path}. A parity gate never writes a fixture silently; ` +
        'regenerate on purpose with UPDATE_PARITY=1 and commit the JSON.',
    );
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

// Env vars that decide provider/platform availability or leak a credential.
const CREDENTIAL_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY|AUTH|BEARER)/i;
const PROVIDER_ENV =
  /^(ANTHROPIC|OPENAI|OPENROUTER|GOOGLE|GEMINI|XAI|AZURE|AWS|BEDROCK|GROQ|MISTRAL|DEEPSEEK|OLLAMA|TELEGRAM|DISCORD|SLACK|WHATSAPP|EMAIL|TAVILY|BRAVE|EXA|FIRECRAWL|ELEVENLABS|DEEPGRAM|LIVEKIT|GITHUB|ETHOS)_/i;

export interface HermeticEnv {
  /** Temp `HOME`. */
  home: string;
  /** Temp `ETHOS_STATE_DIR` (`<home>/.ethos`). */
  stateDir: string;
  /** Restores every env var and removes the temp tree. Idempotent. */
  restore: () => void;
}

/**
 * Temp `HOME` and `ETHOS_STATE_DIR`, with every provider/platform/credential env var
 * cleared via `vi.stubEnv`, so `isAvailable()` answers and defaults are stable across
 * machines. Call `restore()` in `afterAll`.
 */
export function withHermeticEnv(): HermeticEnv {
  const home = mkdtempSync(join(tmpdir(), 'ethos-parity-'));
  const stateDir = join(home, '.ethos');
  mkdirSync(stateDir, { recursive: true });
  for (const name of Object.keys(process.env)) {
    if (CREDENTIAL_ENV.test(name) || PROVIDER_ENV.test(name)) vi.stubEnv(name, undefined);
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ETHOS_STATE_DIR', stateDir);
  vi.stubEnv('NO_COLOR', '1');
  let done = false;
  return {
    home,
    stateDir,
    restore: () => {
      if (done) return;
      done = true;
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export interface RecordedCall {
  messages: Message[];
  tools: ToolDefinitionLite[];
  options: CompletionOptions;
}

export interface ScriptedLLM extends LLMProvider {
  calls: RecordedCall[];
}

/** A provider that records each `complete()` call and answers `"ok"`. */
export function scriptedLLM(reply = 'ok'): ScriptedLLM {
  const calls: RecordedCall[] = [];
  return {
    name: 'scripted',
    model: 'scripted-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    calls,
    async *complete(
      messages: Message[],
      tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      calls.push({ messages, tools, options });
      yield { type: 'text_delta', text: reply };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}
