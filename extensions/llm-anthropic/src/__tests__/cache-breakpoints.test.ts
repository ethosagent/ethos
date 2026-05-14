// context_compression F2 — message-history cache breakpoint placement.

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { applyMessageCacheBreakpoints } from '../index';

function textMsg(role: 'user' | 'assistant', text: string): Anthropic.MessageParam {
  return { role, content: text };
}

function blockMsg(role: 'user' | 'assistant'): Anthropic.MessageParam {
  return {
    role,
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
  };
}

// Read the cache_control flag off a message's last content block.
function lastBlockCached(msg: Anthropic.MessageParam | undefined): boolean {
  if (!msg || typeof msg.content === 'string') return false;
  const last = msg.content[msg.content.length - 1];
  return Boolean(last && 'cache_control' in last && last.cache_control);
}

describe('applyMessageCacheBreakpoints', () => {
  it('converts a string-content message to a block with cache_control', () => {
    const msgs = [textMsg('user', 'hello')];
    applyMessageCacheBreakpoints(msgs, [0], 4);
    expect(Array.isArray(msgs[0]?.content)).toBe(true);
    expect(lastBlockCached(msgs[0])).toBe(true);
  });

  it('marks the last content block of an array-content message', () => {
    const msgs = [blockMsg('assistant')];
    applyMessageCacheBreakpoints(msgs, [0], 4);
    const content = msgs[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const [first, second] = content;
      expect(first && 'cache_control' in first && first.cache_control).toBeFalsy();
      expect(second && 'cache_control' in second && second.cache_control).toBeTruthy();
    }
  });

  it('keeps the deepest breakpoints when over maxAllowed', () => {
    const msgs = [
      textMsg('user', '0'),
      textMsg('assistant', '1'),
      textMsg('user', '2'),
      textMsg('assistant', '3'),
    ];
    // 4 breakpoints, 2 slots — caching pays off on the largest stable prefix,
    // so the shallowest boundaries (0, 1) are dropped, not the deepest.
    applyMessageCacheBreakpoints(msgs, [0, 1, 2, 3], 2);
    expect(lastBlockCached(msgs[0])).toBe(false);
    expect(lastBlockCached(msgs[1])).toBe(false);
    expect(lastBlockCached(msgs[2])).toBe(true);
    expect(lastBlockCached(msgs[3])).toBe(true);
  });

  it('keeps the deepest breakpoint even when given out of order', () => {
    const msgs = [textMsg('user', '0'), textMsg('assistant', '1'), textMsg('user', '2')];
    applyMessageCacheBreakpoints(msgs, [2, 0, 1], 1);
    expect(lastBlockCached(msgs[0])).toBe(false);
    expect(lastBlockCached(msgs[1])).toBe(false);
    expect(lastBlockCached(msgs[2])).toBe(true);
  });

  it('drops out-of-range and duplicate indices', () => {
    const msgs = [textMsg('user', '0'), textMsg('assistant', '1')];
    applyMessageCacheBreakpoints(msgs, [-1, 0, 0, 5, 1], 4);
    expect(lastBlockCached(msgs[0])).toBe(true);
    expect(lastBlockCached(msgs[1])).toBe(true);
  });

  it('is a no-op when maxAllowed is zero', () => {
    const msgs = [textMsg('user', '0')];
    applyMessageCacheBreakpoints(msgs, [0], 0);
    expect(typeof msgs[0]?.content).toBe('string');
  });
});
