/**
 * What the webview does with a turn's final text — the one decision inside
 * `finalizeStream` in ./webview.ts.
 *
 * The webview runs an inline script string, so this function is not imported
 * there: its SOURCE is interpolated into that script (`decideFinalize.toString()`
 * in `getWebviewContent`). One definition, no mirrored copy to drift; the test
 * pins both the decision and that the script carries exactly this source
 * (./__tests__/finalize.test.ts). Keep it self-contained — no closure over
 * module scope, no imports — or the interpolated copy stops working.
 *
 * `resultText` is the ACP result's text (apps/acp-server/src/index.ts): the
 * WHOLE reply — the streamed text plus `answerSuffix` from @ethosagent/types,
 * which is how a `returnDirect` tool's answer (it arrives only as `done.text`,
 * possibly after a streamed preamble) gets in. A result that begins with what
 * streamed is that whole reply and fills the element. One that does not is an
 * answer that never streamed (a server predating that), and it goes AFTER the
 * streamed preamble rather than over it — the same rule `answerSuffix`
 * applies: owed unless the streamed text already ends with it, after a blank
 * line when anything visible streamed. Inlined, not imported, for the reason
 * above.
 */
export function decideFinalize(
  hasStreamElement: boolean,
  streamedText: string,
  resultText: string | undefined,
):
  | { kind: 'fill-stream'; text: string }
  | { kind: 'add-message'; text: string }
  | { kind: 'none' } {
  if (hasStreamElement) {
    if (!resultText || resultText.startsWith(streamedText)) {
      return { kind: 'fill-stream', text: resultText || streamedText };
    }
    if (streamedText.endsWith(resultText)) return { kind: 'fill-stream', text: streamedText };
    const sep = streamedText.trim() ? '\n\n' : '';
    return { kind: 'fill-stream', text: streamedText + sep + resultText };
  }
  if (resultText) return { kind: 'add-message', text: resultText };
  return { kind: 'none' };
}
