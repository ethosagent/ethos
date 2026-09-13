// D17 row 5 / V8 — the model-rejection hint this provider did not have. The
// sibling is `modelRejectionHint` in `extensions/llm-codex/src/models.ts`: a
// narrow, evidence-based read of the vendor's own error body, never a guess at
// what a vendor meant. This is that same shape for Anthropic.
//
// Two differences from the sibling are deliberate. Anthropic rejects an unknown
// model with a 404 as well as a 400, so the status gate is both. And there is no
// per-account model roster to append here, so this returns the WHOLE surfaced
// message rather than a hint the caller concatenates onto the vendor's own.
//
// What it never does is replace the vendor's words. V8 exists because a bare
// vendor error with nothing around it was the entire experience; the fix is to
// keep the body verbatim and untruncated and add a sentence around it.

/**
 * The Anthropic error envelope —
 * `{"type":"error","error":{"type":"not_found_error","message":"model: …"}}`.
 * Only `error.message` is read; the rest of the body is carried verbatim.
 */
function errorMessageOf(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const inner = (json as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return null;
  const message = (inner as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

/**
 * For an Anthropic Messages API failure: the full surfaced message when the
 * vendor is rejecting the MODEL, otherwise `null` and the original error passes
 * through untouched.
 *
 * The predicate is narrow on purpose, the way the codex sibling's two-clause
 * regex is: a 400 or 404 whose body both uses the word "model" AND echoes the
 * model id that was requested. A mis-detected auth or rate-limit error dressed
 * up as a model rejection would be worse than the bare error it replaced, and
 * a rejection this misses degrades to today's behaviour rather than to a lie.
 *
 * The `(HTTP <status>)` on the "vendor said" line is load-bearing, not
 * decoration: `classifyProviderError` in
 * `packages/core/src/providers/chained-provider.ts` reads the status out of the
 * message text (`msg.includes('404')`), and dropping it would move a 404 from
 * `model_not_found` to `unknown` — changing `ChainedProvider`'s exhaustion error
 * from `ALL_PROVIDERS_REJECT_MODEL` to `ALL_PROVIDERS_FAILED`. Pinned by
 * `__tests__/model-rejection.test.ts`.
 */
export function modelRejectionMessage(
  status: number | undefined,
  body: string,
  model: string,
): string | null {
  if (status !== 400 && status !== 404) return null;
  const detail = errorMessageOf(body);
  if (detail === null) return null;
  if (!/\bmodel\b/i.test(detail)) return null;
  if (!detail.toLowerCase().includes(model.toLowerCase())) return null;
  return [
    `anthropic rejected the model "${model}". Nothing ran. The vendor said (HTTP ${status}):`,
    body,
    'Fix: check the model id, or run `ethos models test <alias>` to see what this key can run.',
  ].join('\n');
}
