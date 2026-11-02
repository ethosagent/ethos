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

HOOK_INPUT="$(cat)" exec node --input-type=module - <<'JS'
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_LINES = 400;
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ipynb"]);

function isBinary(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

try {
  const input = JSON.parse(process.env.HOOK_INPUT || "{}");
  if (input.tool_name !== "Read") process.exit(0);
  const args = input.tool_input ?? {};
  if (args.offset !== undefined || args.limit !== undefined) process.exit(0);
  const raw = String(args.file_path ?? "");
  if (raw === "") process.exit(0);
  if (SKIP_EXTENSIONS.has(extname(raw).toLowerCase())) process.exit(0);

  const base = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
  const root = realpathSync(resolve(base));
  const abs = realpathSync(resolve(isAbsolute(raw) ? raw : join(root, raw)));
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) process.exit(0); // outside the repo
  if (!statSync(abs).isFile()) process.exit(0);
  if (isBinary(abs)) process.exit(0);

  const out = execFileSync("wc", ["-l", abs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(lines) || lines <= MAX_LINES) process.exit(0);

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${raw} is ${lines} lines. Read a range (offset/limit), grep for the symbol, or ask a subagent to summarise it.`,
      },
    })}\n`,
  );
} catch {
  // fail open: anything unexpected is "no decision"
}
process.exit(0);
JS
