// The `toolset.yaml` format, in one place (plan personality-memory-boundary G2,
// the amendment store's `applyOps`).
//
// Two packages need it: `@ethosagent/personalities` (the loader reads the file,
// `FilePersonalityRegistry.create`/`update` write it) and
// `@ethosagent/learning-inbox` (a self-amendment computes the exact bytes it
// would write). An extension may not import another extension
// (`architecture.config.ts` `extensions-implement-contracts`), so the format
// lives here — pure string functions, no imports — and both import it.
//
// The format is a flat list: one `- <tool>` line per tool. Any other line
// (a comment, a blank) is ignored on read and NOT preserved on write, so a
// hand-written comment is lost when the file is rendered again.

/**
 * The tool names a `toolset.yaml` lists, in file order.
 *
 * Callers decide what an ABSENT or EMPTY file means before calling this: the
 * loader treats both as "no toolset declared" (every registered built-in tool,
 * `FilePersonalityRegistry` in extensions/personalities/src/index.ts), which is
 * not the same as an empty allowlist.
 */
export function parseToolsetYaml(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/**
 * Render a toolset list as `toolset.yaml` text. An empty list renders a
 * comment line rather than an empty file, so the file stays non-empty and the
 * loader reads it as a DECLARED empty toolset (no tools), not an undeclared one.
 */
export function renderToolsetYaml(toolset: readonly string[]): string {
  if (toolset.length === 0) return '# No tools enabled — agent runs without external action.\n';
  return `${toolset.map((t) => `- ${t}`).join('\n')}\n`;
}
