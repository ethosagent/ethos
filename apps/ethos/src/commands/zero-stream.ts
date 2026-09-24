import { redactArgs } from '@ethosagent/core';
import { redactString } from '@ethosagent/safety-redact';
import {
  credentialInstruction,
  type EventTranslator,
  shouldSurfaceProgress,
} from '@ethosagent/surface-kit';
import { type AgentEvent, answerSuffix } from '@ethosagent/types';

/**
 * The `ethos -z --format stream-json|json` wire (plan hermes-0.21.4-fixes §7).
 *
 * One `JSON.stringify` object per line, each carrying `v: 1` and a `type`, in
 * `AgentEvent`'s camelCase names (D26): an `init` line, the allow-listed event
 * lines, and exactly one `result` line. Adding a field does not bump `v`;
 * removing, renaming or re-meaning one does. This is deliberately not the web
 * wire (`packages/web-contracts/src/events.ts`): that one is unversioned and
 * carries `tool_end.result`, which this one never does (D30).
 */
export const ZERO_STREAM_VERSION = 1;

/** `result.error.code` for a turn refused for a missing plugin credential. */
export const CREDENTIAL_REQUIRED_CODE = 'CREDENTIAL_REQUIRED';

type Ev<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

export interface ZeroResultUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ZeroResultError {
  code: string;
  message: string;
}

export type ZeroStreamLine =
  | { v: 1; type: 'init'; sessionKey: string; personalityId: string; ethosVersion: string }
  | {
      v: 1;
      type: 'run_start';
      provider: string;
      model: string;
      source: Ev<'run_start'>['source'];
      deviation?: Ev<'run_start'>['deviation'];
      traceId?: string;
    }
  | { v: 1; type: 'text_delta'; text: string }
  | { v: 1; type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { v: 1; type: 'tool_progress'; toolName: string; message: string; percent?: number }
  | {
      v: 1;
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      durationMs: number;
      error?: string;
    }
  | {
      v: 1;
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | {
      v: 1;
      type: 'halt';
      kind: 'budget' | 'watcher';
      rule: string;
      toolName?: string;
      count?: number;
      message: string;
    }
  | { v: 1; type: 'error'; code: string; error: string }
  | {
      v: 1;
      type: 'result';
      ok: boolean;
      exitCode: 0 | 1;
      text: string;
      turnCount: number | null;
      traceId?: string;
      usage: ZeroResultUsage;
      halt: Omit<Ev<'halt'>, 'type'> | null;
      error: ZeroResultError | null;
      sessionKey: string;
      durationMs: number;
    };

/**
 * Map one `AgentEvent` to its stream-json line, or `null` when the event is
 * not part of the wire.
 *
 * An ALLOW-LIST (D27): `thinking_delta`, `done` (folded into `result`),
 * `context_meta`, approvals, evaluators, credential and notification events —
 * and every variant added to `AgentEvent` later — return `null`, so a new
 * variant never reaches a public format by default. Obeys the Phase 30.2
 * audience rule, because stream-json is a surface (D28): progress passes only
 * through `shouldSurfaceProgress`, and `'internal'` tool calls are dropped
 * except a failed `tool_end`. Tool args are redacted and truncated, error
 * strings redacted, and tool output bodies never emitted (D30). Pattern
 * redaction misses a secret in a shape it does not know — a recorded limit.
 * Pinned by `apps/ethos/src/__tests__/zero-stream-json.test.ts`.
 */
export function encodeZeroEvent(event: AgentEvent): ZeroStreamLine | null {
  switch (event.type) {
    case 'run_start':
      return {
        v: 1,
        type: 'run_start',
        provider: event.provider,
        model: event.model,
        source: event.source,
        ...(event.deviation !== undefined ? { deviation: event.deviation } : {}),
        ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
      };
    case 'text_delta':
      return { v: 1, type: 'text_delta', text: event.text };
    case 'tool_start':
      if (event.audience === 'internal') return null;
      return {
        v: 1,
        type: 'tool_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: redactArgs(event.args, redactString),
      };
    case 'tool_progress':
      if (!shouldSurfaceProgress(event)) return null;
      return {
        v: 1,
        type: 'tool_progress',
        toolName: event.toolName,
        message: event.message,
        ...(event.percent !== undefined ? { percent: event.percent } : {}),
      };
    case 'tool_end':
      // A failure always renders, whatever its audience (AgentEvent's own rule).
      if (event.ok && event.audience === 'internal') return null;
      return {
        v: 1,
        type: 'tool_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ok: event.ok,
        durationMs: event.durationMs,
        ...(event.error !== undefined ? { error: redactString(event.error) } : {}),
      };
    case 'usage':
      return {
        v: 1,
        type: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostUsd: event.estimatedCostUsd,
        ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
        ...(event.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: event.cacheCreationTokens }
          : {}),
      };
    case 'halt':
      return {
        v: 1,
        type: 'halt',
        kind: event.kind,
        rule: event.rule,
        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.count !== undefined ? { count: event.count } : {}),
        message: event.message,
      };
    case 'error':
      return { v: 1, type: 'error', code: event.code, error: redactString(event.error) };
    default:
      return null;
  }
}

export interface ResultExtras {
  sessionKey: string;
  durationMs: number;
  traceId?: string;
  /** A failure that is not an `error` event: a throw or a setup refusal. */
  error?: ZeroResultError;
}

/**
 * Build the single `result` line from the translator's folded state. `text`
 * is `streamed + answerSuffix(streamed, done.text)`, the reply `--no-stream`
 * prints. The exit code is 1 for an `error` event or a failure passed in
 * `extras.error`, otherwise 0 — a halted turn included (D32).
 *
 * A turn refused for a missing plugin credential (openclaw-9.5 item 1) has no
 * event line of its own (`credential_required` stays off the allow-list), so
 * it is reported here: `error.code` `CREDENTIAL_REQUIRED`, `error.message` the
 * one-line instruction naming `ethos plugin credentials <id> --set <KEY>`
 * (`credentialInstruction` in @ethosagent/surface-kit), exit 1. The event
 * carries no value, so neither does this line.
 */
export function buildResultLine(translator: EventTranslator, extras: ResultExtras): ZeroStreamLine {
  const streamed = translator.text;
  const credential = translator.credentialRequired;
  const error: ZeroResultError | null = translator.error
    ? { code: translator.error.code, message: redactString(translator.error.error) }
    : extras.error
      ? { code: extras.error.code, message: redactString(extras.error.message) }
      : credential
        ? { code: CREDENTIAL_REQUIRED_CODE, message: credentialInstruction(credential) }
        : null;
  const exitCode = error ? 1 : 0;
  const halt = translator.halt;
  return {
    v: 1,
    type: 'result',
    ok: exitCode === 0,
    exitCode,
    text: streamed + answerSuffix(streamed, translator.done?.text),
    turnCount: translator.done?.turnCount ?? null,
    ...(extras.traceId !== undefined ? { traceId: extras.traceId } : {}),
    usage: { ...translator.usage },
    halt: halt ? { ...halt } : null,
    error,
    sessionKey: extras.sessionKey,
    durationMs: extras.durationMs,
  };
}

export interface JsonlWriter {
  write(line: ZeroStreamLine): Promise<void>;
  flush(): Promise<void>;
}

/**
 * JSONL writer that respects backpressure and can be flushed before exit
 * (D33). `index.ts` calls `process.exit()` right after `runZero` returns, and
 * `process.exit()` does not wait for pending asynchronous stdout writes, so
 * `write` waits for `'drain'` whenever `out.write` returns `false`, and
 * `flush` resolves on the callback of an empty final write. A stream that
 * errors or closes (the reader went away) also releases a waiting `write` —
 * it must not hang the process. Pinned by `zero-stream-json.test.ts`.
 */
export function createJsonlWriter(out: NodeJS.WritableStream): JsonlWriter {
  return {
    async write(line) {
      if (out.write(`${JSON.stringify(line)}\n`)) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          out.off('drain', done);
          out.off('error', done);
          out.off('close', done);
          resolve();
        };
        out.on('drain', done);
        out.on('error', done);
        out.on('close', done);
      });
    },
    flush() {
      return new Promise<void>((resolve) => {
        out.write('', () => resolve());
      });
    },
  };
}
