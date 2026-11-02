#!/usr/bin/env bash
# Claude Code SessionStart hook (matcher: compact): after a compaction, re-state the active plan.
#
# Prints nothing and exits 0 when plan/ is missing (it is gitignored, so a fresh clone has none).
# Otherwise: `Active plan: <path>` from plan/.active if present, else the newest-mtime plan/*.md;
# then `Handoff: HANDOFF.md` if that file exists. Plain stdout is added to Claude's context.
#
# Registered in .claude/settings.json (maintainer-applied; see plan/context-budget-1-settings.diff).

HOOK_INPUT="$(cat)" exec node --input-type=module - <<'JS'
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

try {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(process.env.HOOK_INPUT || "{}");
    if (typeof input.cwd === "string" && input.cwd !== "") cwd = input.cwd;
  } catch {
    // no payload: use process.cwd()
  }
  const planDir = join(cwd, "plan");
  if (!existsSync(planDir) || !statSync(planDir).isDirectory()) process.exit(0);

  const lines = [];
  let active = "";
  try {
    active = readFileSync(join(planDir, ".active"), "utf8").trim();
  } catch {
    // no .active
  }
  if (active === "") {
    const newest = readdirSync(planDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ f, t: statSync(join(planDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest) active = `plan/${newest.f}`;
  }
  if (active !== "") lines.push(`Active plan: ${active}`);
  if (existsSync(join(cwd, "HANDOFF.md"))) lines.push("Handoff: HANDOFF.md");
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
} catch {
  // fail open
}
process.exit(0);
JS
