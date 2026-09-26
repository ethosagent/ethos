// archcheck-fixture: place-at extensions/archcheck-fixture/src/empty-catch.ts
//
// A genuinely empty catch — no statements and no comment. A catch holding only a comment is an
// explained silence, which the rule allows, so this block must stay empty.
export function swallow(risky: () => number): number {
  try {
    return risky();
  } catch {}
  return 0;
}
