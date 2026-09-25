// The CLI / TUI approval gate (`wireTerminalApprovalGate`) and the readline
// prompt on top of it (`attachCliApprovalPrompt`). A flagged call asks, runs on
// `y`, is refused on `n` / Enter / timeout; a hardline call is refused without
// asking; a run nobody can answer refuses; command substitution becomes
// approvable because the loop is marked; parallel prompts queue.
//
// apps/ethos does not depend on `@ethosagent/tools-terminal`, so the guard here
// is a stand-in with the real guard's decision (`hardlineReason`, then
// `approvalRequiredReason` unless `hasHostApprovalGate`), registered FIRST as
// `composeAllTools` does. The real composed guard is pinned by
// packages/wiring/src/__tests__/command-substitution-guard.test.ts.

import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  BeforeToolCallResult,
  ExecutionPosture,
  PersonalityConfig,
  PersonalityRegistry,
} from '@ethosagent/types';
import { approvalRequiredReason, hardlineReason, hasHostApprovalGate } from '@ethosagent/wiring';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalCoordinator } from '../approval-coordinator';
import { attachCliApprovalPrompt } from '../lib/cli-approval-prompt';
import {
  createTerminalApprovalSource,
  formatApprovalArgsPreview,
  wireTerminalApprovalGate,
} from '../terminal-approval';

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-terminal-approval-'));
  previousStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(async () => {
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const LOCAL: ExecutionPosture = { backend: 'local' } as ExecutionPosture;

function registry(personality?: PersonalityConfig): PersonalityRegistry {
  return { get: () => personality } as unknown as PersonalityRegistry;
}

/** A loop's hooks with the stand-in terminal guard registered first. */
function loopHooks(): DefaultHookRegistry {
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', async (payload) => {
    const hardline = hardlineReason(payload);
    if (hardline) return { error: `Command blocked: ${hardline}.` };
    const approval = approvalRequiredReason(payload);
    if (approval && !hasHostApprovalGate(hooks)) return { error: `Command blocked: ${approval}.` };
    return null;
  });
  return hooks;
}

let callSeq = 0;
function fire(
  hooks: DefaultHookRegistry,
  command: string,
  personalityId = 'p1',
): Promise<Partial<BeforeToolCallResult>> {
  callSeq += 1;
  return hooks.fireModifying('before_tool_call', {
    sessionId: 'sid-1',
    toolCallId: `tc-${callSeq}`,
    toolName: 'terminal',
    args: { command },
    personalityId,
  });
}

/** A readline stand-in: `answer(line)` types a line. */
class FakeReadline extends EventEmitter {
  prompts: string[] = [];
  private current = '';
  setPrompt(p: string): void {
    this.current = p;
  }
  prompt(): void {
    this.prompts.push(this.current);
  }
  answer(line: string): void {
    this.emit('line', line);
  }
}

function wire(opts: {
  interactive: boolean;
  timeoutMs?: number;
  personality?: PersonalityConfig;
  posture?: ExecutionPosture;
}) {
  const hooks = loopHooks();
  const coordinator = opts.interactive
    ? new ApprovalCoordinator({ timeoutMs: opts.timeoutMs ?? 0 })
    : null;
  const unwire = wireTerminalApprovalGate(hooks, {
    personalities: registry(opts.personality),
    getProvider: async () => {
      throw new Error('no provider in this test');
    },
    model: 'test-model',
    executionPostureFor: () => opts.posture ?? LOCAL,
    coordinator,
    nonInteractive: 'this run has no terminal to ask in',
  });
  const rl = new FakeReadline();
  const written: string[] = [];
  const events: string[] = [];
  const prompt = coordinator
    ? attachCliApprovalPrompt({
        source: createTerminalApprovalSource(coordinator, 'cli'),
        rl,
        write: (text) => written.push(text),
        onOpen: () => events.push('open'),
        onClose: () => events.push('close'),
      })
    : undefined;
  return { hooks, coordinator, rl, written, events, prompt, unwire };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('terminal approval gate — CLI prompt', () => {
  it('marks the loop with the host approval gate, and unwiring removes the mark', () => {
    const { hooks, unwire } = wire({ interactive: true });
    expect(hasHostApprovalGate(hooks)).toBe(true);
    unwire();
    expect(hasHostApprovalGate(hooks)).toBe(false);
  });

  it('a flagged call prompts with tool, reason and args, and runs on "y"', async () => {
    const { hooks, rl, written, events } = wire({ interactive: true });
    const result = fire(hooks, 'ls -la');
    await tick();
    expect(events).toEqual(['open']);
    const shown = written.join('');
    expect(shown).toContain('terminal');
    expect(shown).toContain('terminal requires explicit approval');
    expect(shown).toContain('ls -la');
    expect(rl.prompts.at(-1)).toMatch(/\[y\/N\]/);
    rl.answer('y');
    expect((await result).error).toBeUndefined();
    expect(events).toEqual(['open', 'close']);
  });

  it.each([['n'], [''], ['maybe']])('answer %j refuses the call', async (answer) => {
    const { hooks, rl } = wire({ interactive: true });
    const result = fire(hooks, 'ls -la');
    await tick();
    rl.answer(answer);
    expect((await result).error).toMatch(/denied by user — terminal requires explicit approval/);
  });

  it('an unanswered prompt times out as a deny and closes', async () => {
    const { hooks, events, written } = wire({ interactive: true, timeoutMs: 30 });
    const result = await fire(hooks, 'ls -la');
    expect(result.error).toMatch(/approval timed out/);
    expect(events).toEqual(['open', 'close']);
    expect(written.join('')).toMatch(/denied/);
  });

  it('a hardline command is refused without a prompt', async () => {
    const { hooks, events, coordinator } = wire({ interactive: true });
    const result = await fire(hooks, 'rm -rf /');
    expect(events).toEqual([]);
    expect(coordinator?.pendingCount()).toBe(0);
    expect(result.error).toMatch(/recursive force-delete of root or home directory/);
  });

  it('kill $(lsof -t -i:3000) becomes approvable: it prompts and runs on "y"', async () => {
    const { hooks, rl, written } = wire({
      interactive: true,
      posture: { backend: 'docker' } as ExecutionPosture,
    });
    const result = fire(hooks, 'kill $(lsof -t -i:3000)');
    await tick();
    expect(written.join('')).toContain(
      'terminal requires explicit approval (command substitution)',
    );
    rl.answer('yes');
    expect((await result).error).toBeUndefined();
  });

  it('two parallel flagged calls prompt one after the other', async () => {
    const { hooks, rl, written, events } = wire({ interactive: true });
    const first = fire(hooks, 'echo first');
    const second = fire(hooks, 'echo second');
    await tick();
    expect(written.join('')).toContain('echo first');
    expect(written.join('')).not.toContain('echo second');
    rl.answer('n');
    await tick();
    expect(written.join('')).toContain('echo second');
    rl.answer('y');
    expect((await first).error).toMatch(/denied by user/);
    expect((await second).error).toBeUndefined();
    // One open/close pair around the whole queue.
    expect(events).toEqual(['open', 'close']);
  });

  it('a run that cannot ask refuses a flagged call with a clear reason', async () => {
    const { hooks } = wire({ interactive: false });
    expect(hasHostApprovalGate(hooks)).toBe(true);
    const flagged = await fire(hooks, 'ls -la');
    expect(flagged.error).toMatch(/needs approval, and this run has no terminal to ask in/);
    const substitution = await fire(hooks, 'kill $(lsof -t -i:3000)');
    expect(substitution.error).toMatch(/command substitution/);
    const hardline = await fire(hooks, 'rm -rf /');
    expect(hardline.error).toMatch(/recursive force-delete of root or home directory/);
  });

  it('an unflagged call on a docker posture neither prompts nor refuses', async () => {
    const { hooks, events } = wire({
      interactive: true,
      posture: { backend: 'docker' } as ExecutionPosture,
    });
    const result = await fire(hooks, 'ls -la');
    expect(result.error).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('approvalMode off keeps running flagged calls unasked, but still asks for substitution and refuses hardline', async () => {
    const personality = { id: 'p1', safety: { approvalMode: 'off' } } as PersonalityConfig;
    const { hooks, rl, events } = wire({ interactive: true, personality });
    // `session_start` teaches the predicate which personality the turn runs.
    await hooks.fireVoid('session_start', { sessionId: 'sid-1', personalityId: 'p1' } as never);
    expect((await fire(hooks, 'ls -la')).error).toBeUndefined();
    expect(events).toEqual([]);
    expect((await fire(hooks, 'rm -rf /')).error).toMatch(/recursive force-delete/);
    const substitution = fire(hooks, 'kill $(lsof -t -i:3000)');
    await tick();
    expect(events).toEqual(['open']);
    rl.answer('n');
    expect((await substitution).error).toMatch(/command substitution/);
  });

  it('redacts secrets and truncates the args preview', () => {
    const preview = formatApprovalArgsPreview({
      command: `curl -H "Authorization: Bearer sk-ant-api03-${'a'.repeat(40)}" ${'x'.repeat(600)}`,
    });
    expect(preview).not.toContain('sk-ant-api03-aaaa');
    expect(preview.length).toBeLessThanOrEqual(300);
    expect(preview.endsWith('…')).toBe(true);
  });
});

// Every loop `ethos chat` and `ethos acp` build is gated: the one-shot, the TUI
// (and each `/model` rebuild), the readline REPL, and ACP. Source-level, like
// the serve.ts gate in packages/wiring/src/__tests__/approval-seams.test.ts —
// booting either command needs a provider and a state dir.
describe('terminal approval gate — wiring', () => {
  it('chat gates the -q, TUI, /model-rebuild and readline loops', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'commands', 'chat.ts'), 'utf-8');
    expect(src).toMatch(/gateLoop\(runtime, false, /);
    expect(src).toMatch(/gateLoop\(runtime, true, ''\)/);
    expect(src).toMatch(/gateLoop\(next, true, ''\)/);
    expect(src).toMatch(/gateLoop\(runtime, approvalInteractive, /);
    expect(src).toMatch(/approvals: createTerminalApprovalSource\(approvalCoordinator, 'tui'\)/);
    expect(src).toMatch(/const approvalInteractive = process\.stdin\.isTTY === true;/);
  });

  it('acp gates its loop with no one to ask', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'commands', 'acp.ts'), 'utf-8');
    expect(src).toMatch(/gateNonInteractiveLoop\(\s*runtime,/);
  });
});
