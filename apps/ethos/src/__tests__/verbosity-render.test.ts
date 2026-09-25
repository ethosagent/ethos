import { type AgentEvent, describeDeviation } from '@ethosagent/core';
import type { ModelDeviation } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { isVerbosity, nextVerbosity, projectEvent, unstreamedDoneText } from '../lib/verbosity';

const ev = {
  text(text: string): AgentEvent {
    return { type: 'text_delta', text };
  },
  toolStart(toolName: string): AgentEvent {
    return { type: 'tool_start', toolCallId: 'c1', toolName, args: {} };
  },
  progress(toolName: string, message: string, audience: 'user' | 'internal'): AgentEvent {
    return { type: 'tool_progress', toolName, message, audience };
  },
  toolEnd(toolName: string, ok: boolean, ms: number): AgentEvent {
    return { type: 'tool_end', toolCallId: 'c1', toolName, ok, durationMs: ms };
  },
  usage(inputTokens: number, outputTokens: number): AgentEvent {
    return { type: 'usage', inputTokens, outputTokens, estimatedCostUsd: 0.001 };
  },
  runStart(deviation?: ModelDeviation): AgentEvent {
    return {
      type: 'run_start',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      source: 'default',
      ...(deviation ? { deviation } : {}),
    };
  },
};

const deviation: ModelDeviation = {
  kind: 'role-unbound',
  declared: 'deep',
  effective: 'sonnet',
  reason: "anthropic · claude-sonnet-5 is this machine's default model.",
  once: true,
};

describe('FW-10 verbosity projection', () => {
  describe('quiet', () => {
    it('emits only final assistant text', () => {
      const lines = projectEvent(ev.text('hello'), 'quiet');
      expect(lines).toEqual([{ text: 'hello', kind: 'text' }]);
    });

    it('drops every non-text event', () => {
      expect(projectEvent(ev.toolStart('ls'), 'quiet')).toEqual([]);
      expect(projectEvent(ev.progress('ls', 'half', 'user'), 'quiet')).toEqual([]);
      expect(projectEvent(ev.toolEnd('ls', true, 50), 'quiet')).toEqual([]);
      expect(projectEvent(ev.usage(10, 20), 'quiet')).toEqual([]);
      expect(projectEvent(ev.runStart(), 'quiet')).toEqual([]);
    });

    // D17 — the one exception, and the whole of the contract: a person reading
    // a reply at `quiet` is exactly who needs to know the turn did not run on
    // what was declared.
    it('a run_start carrying a deviation renders at quiet verbosity', () => {
      const lines = projectEvent(ev.runStart(deviation), 'quiet');

      expect(lines).toHaveLength(1);
      expect(lines[0]?.kind).toBe('run_start');
      // The copy is describeDeviation's, never restated at the render site.
      const { line, fix } = describeDeviation(deviation);
      expect(lines[0]?.text).toBe(`${line} ${fix}`);
    });
  });

  describe('default', () => {
    it('surfaces text + tool chips + usage', () => {
      expect(projectEvent(ev.text('hi'), 'default')).toHaveLength(1);
      expect(projectEvent(ev.toolStart('terminal'), 'default')[0].kind).toBe('tool_start');
      expect(projectEvent(ev.toolEnd('terminal', true, 312), 'default')[0].kind).toBe('tool_end');
      expect(projectEvent(ev.usage(50, 70), 'default')[0].kind).toBe('usage');
    });

    it('respects audience boundary — internal progress dropped', () => {
      expect(projectEvent(ev.progress('terminal', 'phase 2', 'internal'), 'default')).toEqual([]);
    });

    it('Lane E — internal inner-call tool_start/tool_end dropped (one chip per script)', () => {
      const innerStart: AgentEvent = {
        type: 'tool_start',
        toolCallId: 'call-1#3',
        toolName: 'read_file',
        args: {},
        audience: 'internal',
      };
      const innerEnd: AgentEvent = {
        type: 'tool_end',
        toolCallId: 'call-1#3',
        toolName: 'read_file',
        ok: false,
        durationMs: 4,
        audience: 'internal',
        error: 'boom',
      };
      expect(projectEvent(innerStart, 'default')).toEqual([]);
      // Internal ends stay hidden even on failure — inner errors are script data.
      expect(projectEvent(innerEnd, 'default')).toEqual([]);
      // verbose lifts the gate, same rule as tool_progress.
      expect(projectEvent(innerStart, 'verbose')).toHaveLength(1);
      expect(projectEvent(innerEnd, 'verbose')).toHaveLength(1);
    });

    it('surfaces user-opt-in progress', () => {
      const lines = projectEvent(ev.progress('read_file', 'reading 2MB', 'user'), 'default');
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe('tool_progress');
      expect(lines[0].text).toContain('read_file');
    });
  });

  describe('verbose', () => {
    it('lifts the audience boundary — internal progress surfaces', () => {
      const lines = projectEvent(ev.progress('terminal', 'phase 2', 'internal'), 'verbose');
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe('· terminal: phase 2');
    });
  });

  describe('debug', () => {
    it('appends raw event JSON per event', () => {
      const lines = projectEvent(ev.text('x'), 'debug');
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('text');
      expect(lines[1].kind).toBe('debug');
      expect(lines[1].text.startsWith('[debug] ')).toBe(true);
      expect(JSON.parse(lines[1].text.slice('[debug] '.length))).toEqual({
        type: 'text_delta',
        text: 'x',
      });
    });
  });

  // A `returnDirect` tool result reaches the turn ONLY as `done.text`: core's
  // processTools yields `done` with the tool's value and no text_delta. The
  // REPL passes whether text streamed this turn, so the answer is shown once.
  describe('an answer that arrives only as `done.text`', () => {
    const done = (text: string): AgentEvent => ({ type: 'done', text, turnCount: 1 });

    it('surfaces `done.text` as text when nothing streamed — at every level', () => {
      for (const level of ['quiet', 'default', 'verbose'] as const) {
        expect(projectEvent(done('DIRECT ANSWER'), level, { streamedText: '' })[0]).toEqual({
          text: 'DIRECT ANSWER',
          kind: 'text',
        });
      }
    });

    // The model streamed a preamble, then called a returnDirect tool: the
    // answer never streamed, so it still surfaces — after a blank line.
    it('surfaces the answer after a streamed preamble', () => {
      expect(
        projectEvent(done('DIRECT ANSWER'), 'default', { streamedText: 'Let me look that up.' }),
      ).toEqual([{ text: '\n\nDIRECT ANSWER', kind: 'text' }]);
    });

    it('surfaces nothing when the answer already streamed, or when the caller tracks no turn', () => {
      expect(projectEvent(done('the answer'), 'default', { streamedText: 'the answer' })).toEqual(
        [],
      );
      expect(projectEvent(done('the answer'), 'quiet', { streamedText: 'the answer' })).toEqual([]);
      expect(projectEvent(done('DIRECT ANSWER'), 'default')).toEqual([]);
      expect(projectEvent(done(''), 'default', { streamedText: '' })).toEqual([]);
    });

    it('unstreamedDoneText is the single rule both chat paths use', () => {
      expect(unstreamedDoneText(done('X'), '')).toBe('X');
      expect(unstreamedDoneText(done('X'), 'X')).toBeUndefined();
      expect(unstreamedDoneText(done('X'), 'preamble')).toBe('\n\nX');
      expect(unstreamedDoneText(ev.text('X'), '')).toBeUndefined();
    });
  });

  describe('budget halt (S4/U1)', () => {
    const halt: AgentEvent = {
      type: 'halt',
      kind: 'budget',
      rule: 'cost-cap',
      toolName: '_budget',
      message: 'Stopped: hit $1.00 budget cap for this session ($1.0100 spent)',
    };

    it('renders the cap and the reset command at every verbosity, quiet included', () => {
      for (const level of ['quiet', 'default', 'verbose'] as const) {
        const lines = projectEvent(halt, level).filter((l) => l.kind === 'halt');
        expect(lines).toHaveLength(1);
        expect(lines[0]?.text).toContain('$1.00 budget cap');
        expect(lines[0]?.text).toContain('/budget reset');
      }
    });

    // The loop yields the stop twice — a user-audience `_budget` chip, then the
    // `halt` (`budgetGuardEvents`, packages/core/src/agent-loop/budgets.ts).
    // The halt line already carries the message, so the chip must not repeat it.
    it('the budget stop renders once, not as a progress chip and a halt line', () => {
      const chip: AgentEvent = {
        type: 'tool_progress',
        toolName: '_budget',
        message: halt.type === 'halt' ? halt.message : '',
        audience: 'user',
      };
      for (const level of ['quiet', 'default', 'verbose'] as const) {
        const lines = [...projectEvent(chip, level), ...projectEvent(halt, level)];
        expect(lines.filter((l) => l.text.includes('$1.00 budget cap'))).toHaveLength(1);
      }
    });

    it('a watcher halt renders no halt line — its pause ends with a reply', () => {
      const watcher: AgentEvent = { type: 'halt', kind: 'watcher', rule: 'r', message: 'm' };
      expect(projectEvent(watcher, 'default').filter((l) => l.kind === 'halt')).toEqual([]);
    });
  });

  describe('/verbose cycle order', () => {
    it('cycles default → verbose → debug → quiet → default', () => {
      expect(nextVerbosity('default')).toBe('verbose');
      expect(nextVerbosity('verbose')).toBe('debug');
      expect(nextVerbosity('debug')).toBe('quiet');
      expect(nextVerbosity('quiet')).toBe('default');
    });
  });

  describe('isVerbosity', () => {
    it('accepts the four valid levels', () => {
      expect(isVerbosity('quiet')).toBe(true);
      expect(isVerbosity('default')).toBe(true);
      expect(isVerbosity('verbose')).toBe(true);
      expect(isVerbosity('debug')).toBe(true);
    });

    it('rejects unknown strings', () => {
      expect(isVerbosity('chatty')).toBe(false);
      expect(isVerbosity('')).toBe(false);
    });
  });
});
