// §IX rules-fence locator shared by check-architecture.mjs (parses the fence body as the rules
// document) and check-agent-files.mjs (strips it from ARCHITECTURE.md's prose budget). One parser
// contract, one place that knows its shape.

/**
 * The FIRST ```yaml fence whose first non-blank body line is `# ARCHITECTURE-RULES v1`.
 * Anything else is not the rules block, even if it parses. Returns the regex Match
 * (.index, m[0] = the fence including both delimiters, m[1] = the body), or undefined.
 */
export function findRulesFence(markdown) {
  // Anchored to line starts: §IX's own parser-contract comment contains the
  // literal "```yaml" mid-line, and an unanchored non-greedy match closes on it.
  const fence = /^```yaml\n([\s\S]*?)^```/gm;
  let m = fence.exec(markdown);
  while (m !== null) {
    const body = m[1];
    const firstLine = body.split('\n').find((l) => l.trim() !== '');
    if (firstLine?.trim() === '# ARCHITECTURE-RULES v1') return m;
    m = fence.exec(markdown);
  }
  return undefined;
}
