#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Read): deny a whole-file Read of a text file over 400 lines.
#
# Fail-open by design: a missing, unreadable or binary file, a path outside the repo, an
# offset/limit Read, an image/pdf/notebook, or any parse error exits 0 with no output (no decision).
# A deny is JSON on stdout (hookSpecificOutput.permissionDecision), shown to Claude.
#
# Registered in .claude/settings.json (maintainer-applied; see plan/context-budget-1-settings.diff).
# Test by piping a payload:
#   echo '{"tool_name":"Read","tool_input":{"file_path":"/abs/path"}}' | bash scripts/hooks/read-size-guard.sh

HOOK_INPUT="$(cat)"
case "$HOOK_INPUT" in *'"offset"'* | *'"limit"'*) exit 0 ;; esac
export HOOK_INPUT

exec node --input-type=module - <<'JS'
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_LINES = 400;
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ipynb"]);
const CHUNK = 64 * 1024;

// Reads in 64KB chunks. Returns the newline count, or MAX_LINES + 1 as soon as the count
// exceeds MAX_LINES with `full` false; with `full` true it counts the whole file.
// Returns -1 for a binary file (NUL in any chunk read).
function countLines(path, full) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let lines = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) return lines;
      const chunk = buf.subarray(0, n);
      if (chunk.includes(0)) return -1;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
      if (!full && lines > MAX_LINES) return lines;
    }
  } finally {
    closeSync(fd);
  }
}

// Returns the deny reason, or null to allow.
function check(input) {
  if (input.tool_name !== "Read") return null;
  const raw = String(input.tool_input?.file_path ?? "");
  if (raw === "" || SKIP_EXTENSIONS.has(extname(raw).toLowerCase())) return null;

  const base =
    process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const root = realpathSync(resolve(base));
  const abs = realpathSync(resolve(isAbsolute(raw) ? raw : join(root, raw)));
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // outside the repo
  const st = statSync(abs);
  if (!st.isFile() || st.size <= MAX_LINES) return null; // <= 400 bytes has <= 400 lines

  if (countLines(abs, false) <= MAX_LINES) return null; // also covers binary (-1)
  const lines = countLines(abs, true);
  if (lines < 0) return null; // NUL beyond the first chunk: binary, fail open
  return `${raw} is ${lines} lines. Read a range (offset/limit), grep for the symbol, or ask a subagent to summarise it.`;
}

try {
  const reason = check(JSON.parse(process.env.HOOK_INPUT || "{}"));
  if (reason) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
  }
} catch {
  // fail open: anything unexpected is "no decision"
}
JS
