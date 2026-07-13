// Vendored, dependency-free JSON repair for malformed tool-call arguments.
//
// Local models (Ollama / vLLM class) frequently emit tool arguments that are
// *almost* JSON: wrapped in prose, single-quoted, trailing commas, unquoted
// keys. This runs ONE mechanical repair pass covering those dominant failure
// modes. Valid JSON — even unusual valid JSON — is parsed strictly first and
// returned untouched; repair only ever runs on a genuine parse failure.
//
// Constraint (see plan/phases/local-model-optimization.md Design decisions):
// no `jsonrepair`-style npm dependency in @ethosagent/core. If this grows past
// ~100 lines it should become a pluggable hook instead of living in core.

export type RepairResult = { ok: true; value: unknown } | { ok: false; reason: string };

export function repairJson(raw: string): RepairResult {
  // Strict parse first — valid (even unusual) JSON passes through untouched.
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    // fall through to a single mechanical repair pass
  }

  const block = extractBalancedBlock(raw);
  if (block === null) {
    return { ok: false, reason: 'no JSON object or array found' };
  }

  let repaired = normalizeQuotes(block);
  repaired = quoteUnquotedKeys(repaired);
  repaired = removeTrailingCommas(repaired);

  try {
    return { ok: true, value: JSON.parse(repaired) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unrepairable JSON' };
  }
}

// Strip prose before/after the first balanced {...} or [...] block. Returns the
// substring, or null when no opener exists or the block never balances. Scans
// string-aware so braces inside string literals don't affect the depth count.
function extractBalancedBlock(s: string): string | null {
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  const start =
    objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) return null;

  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\')
        i++; // skip escaped char
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Convert single-quoted string delimiters to double quotes, escaping any raw
// double quotes that appear inside a converted string.
function normalizeQuotes(s: string): string {
  let out = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const escaped = s[i - 1] === '\\';
    if (inDouble) {
      out += c;
      if (c === '"' && !escaped) inDouble = false;
    } else if (inSingle) {
      if (c === "'" && !escaped) {
        inSingle = false;
        out += '"';
      } else if (c === '"') out += '\\"';
      else out += c;
    } else if (c === '"') {
      inDouble = true;
      out += c;
    } else if (c === "'") {
      inSingle = true;
      out += '"';
    } else out += c;
  }
  return out;
}

// Quote bare object keys: {foo: 1} → {"foo": 1}. Anchored on a preceding
// { or , so it never fires inside a string value.
function quoteUnquotedKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

function removeTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}
