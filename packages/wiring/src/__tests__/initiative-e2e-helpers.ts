// Shared by the L9 end-to-end tests (initiative-no-writes*.e2e.test.ts): a hash of a temp
// Ethos home taken before and after a run, and a scripted LLM that records what it was sent.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';

/** Every file under `roots`, keyed by path relative to `base`. */
export function hashTree(base: string, roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.set(
          relative(base, full),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** Paths added, removed or changed between two hashes. */
export function diffHashes(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

/** The ledger's own files: `initiatives.db`, `-wal`, `-shm`. */
export const isLedgerFile = (path: string): boolean =>
  /(^|\/)initiatives\.db(-wal|-shm)?$/.test(path);

/** SQLite's wal-index of any database: any reader rewrites it and it holds no data. */
export const isShm = (path: string): boolean => path.endsWith('.db-shm');

export interface ScriptedCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Scripted LLM: one entry of `responses` per `complete` call, in order. An empty entry (or none
 * left) is a plain end_turn. Each call reports `costUsd`. `seen` holds the messages of each call.
 */
export function scriptedLLM(responses: ScriptedCall[][], costUsd = 0.04) {
  const seen: Message[][] = [];
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages): AsyncIterable<CompletionChunk> {
      const n = seen.push(messages);
      const calls = responses[n - 1] ?? [];
      yield {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: costUsd,
        },
      };
      if (calls.length === 0) {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const id = `call-${n}-${i}`;
        const json = JSON.stringify(c.input);
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.name };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { llm, seen };
}
