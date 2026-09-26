// C1 (plan ux-feedback-and-config-clarity §4) — per-tool spinner lifecycle.
// Fake clock throughout (explicit `now` values); reduced motion mirrors
// ETHOS_NO_SPINNER_ANIMATION=1, which the REPL maps onto `reducedMotion`.

import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_SPINNER_LINES,
  noticeClearsSpinner,
  repaintTickAction,
  shouldRestartThinkingSpinner,
  ToolLiveBlock,
} from '../lib/tool-spinner';

describe('ToolLiveBlock (C1)', () => {
  it('a spinner line exists between tool_start and tool_end at default verbosity', () => {
    const block = new ToolLiveBlock({ reducedMotion: true });
    block.start('c1', 'bash', { cmd: 'make test' }, 1_000);

    const lines = block.linesFor('default', 13_400);
    expect(lines).toHaveLength(1);
    // Static glyph under reduced motion; formatToolFeedLine carries the rest.
    expect(lines[0]).toBe('· ┊ bash · make test · 12.4s');

    block.end('c1');
    expect(block.linesFor('default', 13_500)).toEqual([]);
  });

  it('renders nothing at quiet, whatever is running', () => {
    const block = new ToolLiveBlock({ reducedMotion: true });
    block.start('c1', 'bash', { cmd: 'make test' }, 0);
    expect(block.linesFor('quiet', 5_000)).toEqual([]);
  });

  it('parallel tools render one line each, capped at 4 with a +N more tail', () => {
    const block = new ToolLiveBlock({ reducedMotion: true });
    for (let i = 0; i < 6; i++) block.start(`c${i}`, `tool_${i}`, {}, 0);

    const lines = block.linesFor('default', 1_000);
    expect(lines).toHaveLength(MAX_TOOL_SPINNER_LINES + 1);
    expect(lines[MAX_TOOL_SPINNER_LINES]).toBe('  +2 more');
  });

  it('tracks active tool names for the ↳ progress indent', () => {
    const block = new ToolLiveBlock({ reducedMotion: true });
    block.start('c1', 'bash', {}, 0);
    expect(block.has('bash')).toBe(true);
    expect(block.has('read_file')).toBe(false);
    block.end('c1');
    expect(block.has('bash')).toBe(false);
  });

  it('cycles the braille glyph on tick, static under reduced motion', () => {
    const animated = new ToolLiveBlock();
    const first = animated.frame();
    animated.tick();
    expect(animated.frame()).not.toBe(first);

    const still = new ToolLiveBlock({ reducedMotion: true });
    still.tick();
    expect(still.frame()).toBe('·');
  });
});

describe('repaintTickAction — the interval’s two hard gates', () => {
  const busy = {
    quiet: false,
    spinnerCleared: false,
    drawnBlockLines: 2,
    activeToolCount: 2,
  };

  it('an open prompt silences every repaint — the user is typing on that line', () => {
    // Whatever else is true (spinner running, block drawn, tools active),
    // promptOpen wins: zero repaint output while a clarify/approval prompt
    // owns the input line.
    for (const spinnerCleared of [true, false]) {
      for (const drawnBlockLines of [0, 3]) {
        for (const activeToolCount of [0, 2]) {
          expect(
            repaintTickAction({
              tty: true,
              promptOpen: true,
              quiet: false,
              spinnerCleared,
              drawnBlockLines,
              activeToolCount,
            }),
          ).toBe('none');
        }
      }
    }
  });

  it('non-TTY never repaints in place', () => {
    expect(repaintTickAction({ tty: false, promptOpen: false, ...busy })).toBe('none');
  });

  it('keeps the original precedence when unGated: spinner while it runs, then block', () => {
    expect(repaintTickAction({ tty: true, promptOpen: false, ...busy })).toBe('spinner');
    expect(repaintTickAction({ tty: true, promptOpen: false, ...busy, spinnerCleared: true })).toBe(
      'block',
    );
    expect(
      repaintTickAction({
        tty: true,
        promptOpen: false,
        quiet: false,
        spinnerCleared: true,
        drawnBlockLines: 0,
        activeToolCount: 0,
      }),
    ).toBe('none');
    // Quiet skips the spinner but still maintains a drawn block.
    expect(repaintTickAction({ tty: true, promptOpen: false, ...busy, quiet: true })).toBe('block');
  });
});

describe('noticeClearsSpinner — halt and loop/watcher notices wipe the line first', () => {
  it('halt and _loop/_watcher tool_progress clear; ordinary events do not', () => {
    expect(noticeClearsSpinner({ type: 'halt' })).toBe(true);
    expect(noticeClearsSpinner({ type: 'tool_progress', toolName: '_loop' })).toBe(true);
    expect(noticeClearsSpinner({ type: 'tool_progress', toolName: '_watcher' })).toBe(true);
    expect(noticeClearsSpinner({ type: 'tool_progress', toolName: 'bash' })).toBe(false);
    expect(noticeClearsSpinner({ type: 'usage' })).toBe(false);
    expect(noticeClearsSpinner({ type: 'thinking_delta' })).toBe(false);
  });
});

describe('shouldRestartThinkingSpinner (C1)', () => {
  it('restarts after tool_end when no text has streamed and nothing else runs', () => {
    expect(shouldRestartThinkingSpinner({ textStarted: false, activeToolCount: 0 })).toBe(true);
  });

  it('does not restart once text streamed, or while another tool runs', () => {
    expect(shouldRestartThinkingSpinner({ textStarted: true, activeToolCount: 0 })).toBe(false);
    expect(shouldRestartThinkingSpinner({ textStarted: false, activeToolCount: 2 })).toBe(false);
  });
});
