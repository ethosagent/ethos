import type { EngineAnswer } from './engines/types';

// ---------------------------------------------------------------------------
// Two renderings of one EngineAnswer (plan §6). `text` is what an LLM reads.
// `json` exists because ScriptToolCallResult carries `value` only, so a
// caller across the script-tool seam (the brand plugin) never sees
// `structured` — the machine-readable form has to live in `value` (D5).
// ---------------------------------------------------------------------------

function footer(answer: EngineAnswer): string {
  const searched = answer.searched ? 'searched' : 'not searched';
  return `${answer.engine} · ${answer.model} · ${searched} · ${answer.askedAt}`;
}

export function renderText(answer: EngineAnswer): string {
  const parts: string[] = [];
  if (answer.answerText) parts.push(answer.answerText);
  if (answer.citations.length > 0) {
    const lines = answer.citations
      .map((c, i) => (c.title ? `${i + 1}. ${c.title}\n   ${c.url}` : `${i + 1}. ${c.url}`))
      .join('\n');
    parts.push(`Sources:\n${lines}`);
  }
  if (parts.length === 0) parts.push(`No answer returned for: ${answer.query}`);
  parts.push(footer(answer));
  return parts.join('\n\n');
}

/**
 * Slack under `limit` on each cut: covers the `,"truncated":true` key the
 * first reduction introduces and lets a text cut settle in one or two passes.
 */
const CUT_MARGIN = 64;

/** `text` shortened so that its serialized length fits `textBudget` characters. */
function cutTo(text: string, textBudget: number): string {
  // Escaping inflates the serialized text (`"` -> `\"`, newlines -> `\n`), so the
  // cut is sized in RAW characters from the SERIALIZED budget by the text's own
  // raw:serialized ratio. An uneven prefix just costs another pass of the loop
  // below; every pass shortens the text by at least one character.
  const serialized = JSON.stringify(text).length;
  const keep = textBudget > 0 ? Math.floor((text.length * textBudget) / serialized) : 0;
  return text.slice(0, Math.min(keep, text.length - 1));
}

/**
 * Raw characters of `answerText` the ladder will not cut below while anything
 * else is still droppable. 2,000 characters is a few paragraphs — enough that a
 * reader can tell what the engine said and quote it — while leaving ~26 kB of
 * the 28 kB budget, room for roughly a hundred citations, so the floor itself
 * can never be what forces evidence out.
 */
export const ANSWER_TEXT_FLOOR = 2_000;

/**
 * `JSON.stringify(answer)` guaranteed to be at most `limit` characters.
 *
 * The registry trims a tool result at `maxResultChars` (see
 * `DefaultToolRegistry.executeParallel` in `packages/core/src/tool-registry.ts`),
 * and slicing a serialized JSON document leaves something no parser can read.
 * So the document is fitted to the budget HERE, before it is returned, and
 * `truncated: true` says on the document itself that it was reduced.
 *
 * The reduction ladder drops WHOLE elements rather than cutting inside the
 * serialized form, in this order:
 *
 *   1. trailing `sources` — consulted but not cited, the least valuable thing
 *      in the document;
 *   2. `answerText`, shortened to a prefix but never below `ANSWER_TEXT_FLOOR`;
 *   3. trailing `citations` — the last-cited go first, so citation 1 (the
 *      engine's earliest, and the `position` a caller quotes) survives longest.
 *      Reached only once the answer is already at its floor: this tool returns
 *      an answer WITH its evidence, and the evidence is the half a caller
 *      cannot reconstruct;
 *   4. `query`, shortened to a prefix — the echo of a caller-supplied string,
 *      which is the only remaining unbounded field. The floor gives way here
 *      too: with citations exhausted, prose is once again the cheapest thing
 *      left.
 *
 * Steps 2 and 4 keep a prefix rather than blanking the field: a prefix is
 * strictly more useful than nothing and, because the document is re-serialized
 * afterwards, it can never produce the mid-string cut this function exists to
 * avoid. The ladder terminates — every rung strictly shrinks the payload, and
 * once all four are exhausted the fixed fields alone are far under any sane
 * `limit`.
 */
export function renderJson(
  answer: EngineAnswer,
  limit: number,
): { value: string; answer: EngineAnswer } {
  let current = answer;
  let value = JSON.stringify(current);

  while (value.length > limit) {
    // Budget for the one field being cut: the whole document minus that field's
    // own serialized length is everything the cut cannot touch.
    const budgetFor = (field: string) =>
      limit - (value.length - JSON.stringify(field).length) - CUT_MARGIN;

    if (current.sources.length > 0) {
      current = { ...current, sources: current.sources.slice(0, -1), truncated: true };
    } else if (current.answerText.length > ANSWER_TEXT_FLOOR) {
      const cut = cutTo(current.answerText, budgetFor(current.answerText));
      // The floor is a RAW-character clamp; `cut` is already shorter than
      // `answerText`, and the clamp is too, so the rung still shrinks.
      const answerText =
        cut.length >= ANSWER_TEXT_FLOOR ? cut : current.answerText.slice(0, ANSWER_TEXT_FLOOR);
      current = { ...current, answerText, truncated: true };
    } else if (current.citations.length > 0) {
      current = { ...current, citations: current.citations.slice(0, -1), truncated: true };
    } else if (current.answerText.length > 0) {
      const answerText = cutTo(current.answerText, budgetFor(current.answerText));
      current = { ...current, answerText, truncated: true };
    } else if (current.query.length > 0) {
      const query = cutTo(current.query, budgetFor(current.query));
      current = { ...current, query, truncated: true };
    } else {
      break;
    }
    value = JSON.stringify(current);
  }

  return { value, answer: current };
}
