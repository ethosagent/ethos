// A `returnDirect` answer reaches the webview only as the ACP result's text —
// no `text_delta` came first, so there is no streaming element to fill.
// `finalizeStream` used to fill that element or do nothing, and the answer
// never appeared.

import { describe, expect, it } from 'vitest';
import { decideFinalize } from '../finalize';
import { getWebviewContent } from '../webview';

describe('decideFinalize', () => {
  it('nothing streamed, result text present: render the result once, as a new message', () => {
    expect(decideFinalize(false, '', 'the direct answer')).toEqual({
      kind: 'add-message',
      text: 'the direct answer',
    });
  });

  it('text streamed: fill the streaming element, never a second message', () => {
    expect(decideFinalize(true, 'streamed reply', 'streamed reply')).toEqual({
      kind: 'fill-stream',
      text: 'streamed reply',
    });
  });

  // A preamble streamed, then a returnDirect tool answered. The ACP result is
  // the whole reply (preamble, blank line, answer) — it fills the element.
  it('a whole-reply result that begins with the streamed preamble fills the element', () => {
    expect(
      decideFinalize(true, 'Let me look that up.', 'Let me look that up.\n\nDIRECT ANSWER'),
    ).toEqual({ kind: 'fill-stream', text: 'Let me look that up.\n\nDIRECT ANSWER' });
  });

  // A result that carries only the answer (it never streamed) must not replace
  // the preamble the user already read — it goes after it.
  it('an answer-only result after a streamed preamble keeps the preamble and appends the answer', () => {
    expect(decideFinalize(true, 'Let me look that up.', 'DIRECT ANSWER')).toEqual({
      kind: 'fill-stream',
      text: 'Let me look that up.\n\nDIRECT ANSWER',
    });
  });

  it('text streamed and the result is empty: the streamed text stands', () => {
    expect(decideFinalize(true, 'streamed reply', '')).toEqual({
      kind: 'fill-stream',
      text: 'streamed reply',
    });
  });

  it('nothing streamed and nothing to show: render nothing', () => {
    expect(decideFinalize(false, '', '')).toEqual({ kind: 'none' });
    expect(decideFinalize(false, '', undefined)).toEqual({ kind: 'none' });
  });
});

describe('the webview script', () => {
  // The webview never imports ./finalize — it runs an inline script. It gets
  // this function by source, so the decision under test is the one it runs.
  const html = getWebviewContent(
    {} as Parameters<typeof getWebviewContent>[0],
    {} as Parameters<typeof getWebviewContent>[1],
  );

  it('carries decideFinalize verbatim, and finalizeStream consults it', () => {
    expect(html).toContain(`const decideFinalize = ${decideFinalize.toString()};`);
    const finalize = html.slice(html.indexOf('function finalizeStream('));
    expect(finalize.slice(0, finalize.indexOf('\n  }\n'))).toContain('decideFinalize(');
  });

  it('the interpolated source is a working function on its own', () => {
    // The line the script carries (asserted verbatim above), evaluated with no
    // module scope around it — what the webview does with it.
    const line = `const decideFinalize = ${decideFinalize.toString()};`;
    const inlined = new Function(`${line} return decideFinalize;`)() as typeof decideFinalize;
    expect(inlined(false, '', 'the direct answer')).toEqual({
      kind: 'add-message',
      text: 'the direct answer',
    });
  });
});
