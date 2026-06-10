// E5 — best-effort filesystem-path extractor. Detects path-like arguments
// across the common file/edit/terminal tool shapes so the AgentLoop can fire
// `tool_end_with_path` without each tool re-implementing introspection.
// Returns undefined when no plausible path argument is present (e.g. pure web
// tools).
export function extractFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.path === 'string' && a.path.length > 0) return a.path;
  if (typeof a.file_path === 'string' && a.file_path.length > 0) return a.file_path;
  if (typeof a.filePath === 'string' && a.filePath.length > 0) return a.filePath;
  if (typeof a.cwd === 'string' && a.cwd.length > 0) return a.cwd;
  return undefined;
}
