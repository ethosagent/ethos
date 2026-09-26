import { type AgentEvent, describeDeviation } from '@ethosagent/core';
import { describeChatError } from '@ethosagent/surface-kit';
import type { ModelDeviation } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { formatToolFeedLine } from '../lib/tool-feed';
import {
  isVerbosity,
  nextVerbosity,
  projectEvent,
  thinkingPreview,
  unstreamedDoneText,
} from '../lib/verbosity';

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

  // A2 — a user stop already confirmed itself; the loop's trailing
  // `error(code: 'aborted')` renders nothing when the turn's abort fired.
  describe('aborted suppression (A2)', () => {
    const abortedError: AgentEvent = { type: 'error', error: 'Aborted', code: 'aborted' };

    it('drops the aborted error after a user stop, at every level', () => {
      for (const level of ['default', 'verbose'] as const) {
        const lines = projectEvent(abortedError, level, { streamedText: '', aborted: true });
        expect(lines.filter((l) => l.kind === 'error')).toEqual([]);
      }
    });

    it('still renders a non-user abort and every other error code', () => {
      const notUserStop = projectEvent(abortedError, 'default', {
        streamedText: '',
        aborted: false,
      });
      expect(notUserStop.filter((l) => l.kind === 'error')).toHaveLength(1);

      const other: AgentEvent = { type: 'error', error: 'boom', code: 'llm_error' };
      const lines = projectEvent(other, 'default', { streamedText: '', aborted: true });
      expect(lines.filter((l) => l.kind === 'error')).toHaveLength(1);
    });
  });

  // A3 — the CLI's three-line error render draws all wording from
  // `describeChatError` (surface-kit): title, next step, trace.
  describe('three-line error wording (A3)', () => {
    it('a mapped code yields title, action, and the trace id', () => {
      const described = describeChatError('context_overflow', 'raw provider text', 'tr-123');
      expect(described.title).toBe('conversation too large for the model');
      expect(described.action).toContain('/compact');
      expect(described.trace).toBe('tr-123');
    });

    it('no trace id → no trace line material', () => {
      expect(describeChatError('llm_error', 'raw').trace).toBeUndefined();
    });
  });

  // A4 — loop-level notices ride `tool_progress` with the reserved `_loop`
  // name: one line carrying the message, never a tool row, nothing at quiet.
  describe('_loop notices (A4)', () => {
    const notice: AgentEvent = {
      type: 'tool_progress',
      toolName: '_loop',
      message: 'context overflow — compacting and retrying',
      audience: 'user',
    };

    it('renders the message as one line at default and verbose', () => {
      for (const level of ['default', 'verbose'] as const) {
        const lines = projectEvent(notice, level);
        expect(lines.filter((l) => l.kind === 'tool_progress')).toEqual([
          { text: 'context overflow — compacting and retrying', kind: 'tool_progress' },
        ]);
      }
    });

    it('renders nothing at quiet', () => {
      expect(projectEvent(notice, 'quiet')).toEqual([]);
    });
  });

  // C2 — a failed tool's feed line carries the reason as a second line.
  describe('failed-tool reason line (C2)', () => {
    it('appends the first line of the error under the feed line', () => {
      const line = formatToolFeedLine({
        toolName: 'bash',
        args: { cmd: 'make test' },
        durationMs: 900,
        error: 'exit 2: make: *** [test] Error 2\nlong tail',
      });
      const [feed, reason] = line.split('\n');
      expect(feed).toBe('┊ bash · make test · 900ms');
      expect(reason).toBe('      exit 2: make: *** [test] Error 2');
    });
  });

  // A5 (UD6) — thinking preview at verbose only; nothing at default/quiet.
  describe('thinking preview (A5)', () => {
    it('rolls the latest ~80 chars at verbose, single line', () => {
      const tail = thinkingPreview('', 'first\nthoughts here', 'verbose');
      expect(tail).toBe('first thoughts here');
      const long = thinkingPreview('x'.repeat(100), 'tail', 'verbose');
      expect(long).toHaveLength(80);
      expect(long?.endsWith('tail')).toBe(true);
    });

    it('returns null at default and quiet', () => {
      expect(thinkingPreview('', 'reasoning', 'default')).toBeNull();
      expect(thinkingPreview('', 'reasoning', 'quiet')).toBeNull();
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
