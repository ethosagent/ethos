#!/usr/bin/env bash
# Claude Code SessionStart hook (matcher: compact): after a compaction, re-state the active plan.
#
# Prints nothing and exits 0 when plan/ is missing (it is gitignored, so a fresh clone has none).
# Otherwise: `Active plan: <path>` from plan/.active if present, else the newest-mtime file across
# plan/*.md and plan/phases/*.md (same rule as the handoff skill); then `Handoff: HANDOFF.md` if
# that file exists. Plain stdout is added to Claude's context. Fail-open: any error prints nothing.
#
# Registered in .claude/settings.json (maintainer-applied; see plan/context-budget-1-settings.diff).

HOOK_INPUT="$(cat)" exec node --input-type=module - <<'JS'
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const mdFiles = (dir, prefix) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({ path: `${prefix}${f}`, t: statSync(join(dir, f)).mtimeMs }))
    : [];

try {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(process.env.HOOK_INPUT || "{}");
    if (typeof input.cwd === "string" && input.cwd !== "") cwd = input.cwd;
  } catch {
    // no payload: use process.cwd()
  }
  const planDir = join(cwd, "plan");
  if (existsSync(planDir) && statSync(planDir).isDirectory()) {
    let active = existsSync(join(planDir, ".active"))
      ? readFileSync(join(planDir, ".active"), "utf8").trim()
      : "";
    if (active === "") {
      const files = [...mdFiles(planDir, "plan/"), ...mdFiles(join(planDir, "phases"), "plan/phases/")];
      active = files.sort((a, b) => b.t - a.t)[0]?.path ?? "";
    }
    let out = active === "" ? "" : `Active plan: ${active}\n`;
    if (existsSync(join(cwd, "HANDOFF.md"))) out += "Handoff: HANDOFF.md\n";
    process.stdout.write(out);
  }
} catch {
  // fail open
}
JS
