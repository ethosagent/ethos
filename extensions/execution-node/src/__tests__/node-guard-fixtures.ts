// Shared fixtures for the node-guard-*.test.ts files: temp roots, a policy, a recording approval
// prompt and the `guard()` / `refused()` helpers. `useGuardFixture()` registers a beforeEach, so
// call it inside a describe block; every test then starts with fresh directories and state.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect } from 'vitest';
import type { CallFrame } from '../frames';
import {
  type ApprovalRequest,
  type CommandCheck,
  NodeGuard,
  type NodeGuardOptions,
  type NodePolicy,
} from '../node-guard';
import { NOW } from './fixtures';

export const safeCheck: CommandCheck = () => ({ dangerous: false });

type Refusal = Extract<Awaited<ReturnType<NodeGuard['admit']>>, { ok: false }>['result'];

export interface GuardFixture {
  root: string;
  roRoot: string;
  outside: string;
  home: string;
  policy: NodePolicy;
  prompts: ApprovalRequest[];
  /** What the fake approval prompt answers; tests flip it to false to decline. */
  answer: boolean;
  guard(over?: Partial<NodeGuardOptions>, pol?: Partial<NodePolicy>): NodeGuard;
  refused(g: NodeGuard, f: CallFrame): Promise<Refusal>;
}

export function useGuardFixture(): GuardFixture {
  const fx = {
    guard(over: Partial<NodeGuardOptions> = {}, pol: Partial<NodePolicy> = {}): NodeGuard {
      return new NodeGuard({
        policy: { ...fx.policy, ...pol },
        approve: async (req) => {
          fx.prompts.push(req);
          return fx.answer;
        },
        checkCommand: safeCheck,
        now: () => NOW,
        home: fx.home,
        ...over,
      });
    },
    async refused(g: NodeGuard, f: CallFrame) {
      const out = await g.admit(f);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected refusal');
      return out.result;
    },
  } as GuardFixture;

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'node-guard-')));
    fx.root = join(base, 'root');
    fx.roRoot = join(base, 'ro');
    fx.outside = join(base, 'outside');
    fx.home = join(base, 'home');
    for (const d of [fx.root, fx.roRoot, fx.outside, fx.home, join(fx.root, 'sub')])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(fx.root, 'a.txt'), 'hello');
    writeFileSync(join(fx.outside, 'secret.txt'), 'secret');
    fx.policy = {
      roots: [
        { path: fx.root, readOnly: false },
        { path: fx.roRoot, readOnly: true },
      ],
      tools: ['read_file', 'write_file', 'patch_file', 'search_files'],
      personalities: ['coder'],
      writes: 'ask',
      allowUnattended: false,
    };
    fx.prompts = [];
    fx.answer = true;
  });

  return fx;
}
