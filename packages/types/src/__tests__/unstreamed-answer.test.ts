// The one rule every surface applies to a turn's `done.text`.
//
// In a normal turn `done.text` is the concatenation of every `text_delta` the
// turn streamed (`fullText` in packages/core/src/agent-loop.ts). On the
// `returnDirect` path it is the tool's answer, which never streamed — after
// any preamble the model streamed before calling the tool.

import { describe, expect, it } from 'vitest';
import { answerSuffix, unstreamedAnswer } from '../agent-event';

describe('unstreamedAnswer / answerSuffix', () => {
  it('a normal turn owes nothing: done.text is what streamed', () => {
    expect(unstreamedAnswer('the answer', 'the answer')).toBe('');
    expect(answerSuffix('the answer', 'the answer')).toBe('');
  });

  it('returnDirect with nothing streamed: the answer, bare', () => {
    expect(unstreamedAnswer('', 'DIRECT ANSWER')).toBe('DIRECT ANSWER');
    expect(answerSuffix('', 'DIRECT ANSWER')).toBe('DIRECT ANSWER');
  });

  it('returnDirect after a streamed preamble: the answer, after a blank line', () => {
    expect(unstreamedAnswer('Let me look that up.', 'DIRECT ANSWER')).toBe('DIRECT ANSWER');
    expect(answerSuffix('Let me look that up.', 'DIRECT ANSWER')).toBe('\n\nDIRECT ANSWER');
  });

  it('owes nothing when done carries no text', () => {
    expect(unstreamedAnswer('partial', '')).toBe('');
    expect(answerSuffix('partial', undefined)).toBe('');
  });

  it('whitespace-only streaming takes no separator', () => {
    expect(answerSuffix('\n', 'DIRECT ANSWER')).toBe('DIRECT ANSWER');
  });
});
