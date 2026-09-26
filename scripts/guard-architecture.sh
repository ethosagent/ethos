#!/usr/bin/env bash
# Claude Code PreToolUse guard for the architecture checks (ARCHITECTURE.md §IX).
#
# Changing an architecture rule, an exception or the archcheck baseline needs the maintainer's
# approval. This hook stops an agent from doing it on its own: it exits 2 (which blocks the tool
# call and shows the message to the agent) when
#   - Edit / Write / MultiEdit / NotebookEdit targets a protected path (below), or
#   - a Bash command contains `baseline --write`, `--no-verify`, `LEFTHOOK=0`,
#     `SKIP_PUSH_HOOK=1` or `Architecture-Approved-By`.
# Everything else exits 0.
#
# Input: the hook JSON on stdin (`tool_name`, `tool_input.file_path` | `tool_input.notebook_path`
# | `tool_input.command`, `cwd`). A path is matched relative to the root of the git checkout that
# contains it, and only when that checkout carries this script — so absolute paths, `./` prefixes,
# `..` segments and other worktrees of this repository all resolve, and a same-named file in an
# unrelated repository is left alone.
#
# Known limit: a Bash command that writes a protected file without naming one of the phrases above
# (e.g. `sed -i` on architecture.config.ts) is not caught; review and CI's baseline check are the
# backstop.
#
# Registered in .claude/settings.json. Test by piping a payload:
#   echo '{"tool_name":"Edit","tool_input":{"file_path":"architecture.config.ts"}}' \
#     | bash scripts/guard-architecture.sh; echo $?

# The payload is read here and handed to node through the environment, so node's stdin can carry
# the script as a quoted heredoc (no shell quoting inside the JavaScript).
HOOK_INPUT="$(cat)" exec node --input-type=module - <<'JS'
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PROTECTED_FILES = new Set([
  "architecture.config.ts",
  ".archcheck/baseline.json",
  "packages/types/src/__tests__/archcheck.test.ts",
  "packages/types/src/__tests__/archcheck-fixtures.test.ts",
  "scripts/check-archcheck-baseline.mjs",
  "scripts/guard-architecture.sh",
  // The hook's own registration: removing its PreToolUse entry would disarm every line above.
  ".claude/settings.json",
]);
const PROTECTED_DIRS = ["archcheck-fixtures/"];
const BANNED_PHRASES = [
  "baseline --write",
  "--no-verify",
  "LEFTHOOK=0",
  "SKIP_PUSH_HOOK=1",
  "Architecture-Approved-By",
];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function block(reason) {
  process.stderr.write(
    `[guard-architecture] Blocked: ${reason}\n` +
      "Architecture rules, exceptions and the archcheck baseline change only with the " +
      "maintainer's approval (ARCHITECTURE.md §IX). Do not work around this. Stop and raise a " +
      "request to the maintainer instead: the archcheck rule id, the file, what you need, and the " +
      "proposed diff to architecture.config.ts (a rule change, or an exception with owner, expiry, " +
      "reason and removal condition).\n",
  );
  process.exit(2);
}

/** The git checkout root containing `path` (walking up to an existing directory), or null. */
function checkoutRoot(path) {
  let dir = path;
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  if (!statSync(dir).isDirectory()) dir = dirname(dir);
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** `path` with its longest existing prefix resolved through symlinks (git reports real paths). */
function realPath(path) {
  let dir = path;
  const rest = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return path;
    rest.unshift(relative(up, dir));
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}

let input;
try {
  input = JSON.parse(process.env.HOOK_INPUT || "{}");
} catch {
  process.exit(0); // not a hook payload; nothing to judge
}
const tool = input.tool_name ?? "";
const args = input.tool_input ?? {};

if (tool === "Bash") {
  const command = String(args.command ?? "");
  const hit = BANNED_PHRASES.find((p) => command.includes(p));
  if (hit) block(`the command contains \`${hit}\`.`);
  process.exit(0);
}

if (!EDIT_TOOLS.has(tool)) process.exit(0);

const raw = String(args.file_path ?? args.notebook_path ?? "");
if (raw === "") process.exit(0);
const base = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
const abs = realPath(resolve(isAbsolute(raw) ? raw : join(base, raw)));
const root = checkoutRoot(abs);
if (!root || !existsSync(join(root, "scripts", "guard-architecture.sh"))) process.exit(0);
const rel = relative(root, abs).split(sep).join("/");
if (rel.startsWith("../")) process.exit(0);

if (PROTECTED_FILES.has(rel) || PROTECTED_DIRS.some((d) => rel.startsWith(d))) {
  block(`${tool} on ${rel}, a protected architecture file.`);
}
process.exit(0);
JS
