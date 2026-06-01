import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { ScopedFs, Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BLOCKED_WRITE_PATHS = [
  join(homedir(), '.ethos', 'config.yaml'),
  join(homedir(), '.ethos', 'keys.json'),
  join(homedir(), '.ethos', 'web-token'),
  join(homedir(), '.ethos', 'pairing.db'),
];
const BLOCKED_WRITE_PREFIXES = [
  join(homedir(), '.ethos', 'sessions'),
  join(homedir(), '.ethos', 'secrets'),
];

function expandPath(p: string, cwd: string): string {
  // Expand ~/ first, then resolve unconditionally so `..` and `.`
  // segments are normalized. Without `resolve()`, an absolute path like
  // `/tmp/foo/./../etc/passwd` would skip past the working-dir
  // allowlist via lexical-but-unnormalized prefix matching.
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Normalize a read-target path. ScopedFsImpl.checkReach() applies
 * normalize(resolve(path)) internally before boundary checks, so we
 * no longer need the old realpath()-based symlink canonicalization here.
 * expandPath already resolves `~` and relative segments; this wrapper
 * exists so the call-site semantics stay explicit.
 */
function canonicalizeForRead(path: string): string {
  return resolve(path);
}

function isWriteBlocked(abs: string): boolean {
  const normalized = resolve(abs);
  if (BLOCKED_WRITE_PATHS.some((p) => resolve(p) === normalized)) return true;
  return BLOCKED_WRITE_PREFIXES.some((prefix) => {
    const np = resolve(prefix);
    return normalized === np || normalized.startsWith(`${np}/`);
  });
}

/**
 * FW-28 — check whether the file at `abs` has been modified externally since
 * the agent last read it. Returns a STALE_WRITE ToolResult when stale, or
 * null when the write is safe to proceed.
 *
 * Skipped (returns null) when:
 * - `readMtimes` is absent (backward-compat: old callers without the map)
 * - the path was never read in this session (new-file creation, no false positive)
 *
 * Uses ScopedFs.mtime() so the check is reach-validated by the same
 * capability surface as the surrounding read/write, rather than bypassing
 * it with raw stat(). A file that was previously read but has since been
 * deleted is treated as stale to prevent silent clobber of a disappearance.
 */
async function checkStaleWrite(
  abs: string,
  readMtimes: Map<string, { mtimeMs: number; readAtTurn: number }> | undefined,
  fs: ScopedFs,
): Promise<ToolResult | null> {
  if (!readMtimes) return null;
  const record = readMtimes.get(abs);
  if (!record) return null;

  const currentMtimeMs = await fs.mtime(abs);

  if (currentMtimeMs === null) {
    const readAt = new Date(record.mtimeMs).toISOString();
    return {
      ok: false,
      error: `STALE_WRITE: ${abs} was read at ${readAt} but no longer exists on disk. Re-read the file before writing.`,
      code: 'STALE_WRITE',
      conflictKey: abs,
    };
  }

  if (currentMtimeMs !== record.mtimeMs) {
    const readAt = new Date(record.mtimeMs).toISOString();
    const modAt = new Date(currentMtimeMs).toISOString();
    return {
      ok: false,
      error: `STALE_WRITE: ${abs} was read at ${readAt} but modified externally at ${modAt}. Re-read the file before writing.`,
      code: 'STALE_WRITE',
      conflictKey: abs,
    };
  }

  return null;
}

/**
 * Resolve the ScopedFs to use for this call, or return a `not_available`
 * tool result when the capability backend isn't configured. AgentLoop
 * wires `ctx.scopedFs` from the tool's declared `fs_reach` capability
 * intersected with the personality's `fs_reach`; tests that construct a
 * ToolContext directly must wire it explicitly.
 */
function fsOf(ctx: ToolContext): ScopedFs | ToolResult {
  if (!ctx.scopedFs) {
    return {
      ok: false,
      error: 'Filesystem capability not configured for this personality.',
      code: 'not_available',
    };
  }
  return ctx.scopedFs;
}

/** Detect the structured PATH_NOT_REACHABLE shape thrown by ScopedFsImpl
 *  so tools can return a deterministic failure instead of an unhandled
 *  exception. Match the prefix; ScopedFs is the only caller throwing it. */
function isReachError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith('PATH_NOT_REACHABLE:');
}

function reachFailure(kind: 'read' | 'write', path: string): ToolResult {
  return {
    ok: false,
    error: `Filesystem boundary: ${kind} of "${path}" is outside this personality's fs_reach allowlist.`,
    code: 'execution_failed',
  };
}

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.md',
  '.txt',
  '.csv',
  '.log',
  '.html',
  '.css',
  '.scss',
  '.svg',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sql',
  '.graphql',
  '.proto',
  '.gitignore',
  '.prettierrc',
  '.eslintrc',
]);

function isTextFile(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  return regex.test(name);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file from the filesystem. Supports line ranges for large files. Paths starting with ~/ are expanded to the home directory.',
  toolset: 'file',
  maxResultChars: 40_000,
  outputIsUntrusted: true,
  capabilities: {
    fs_reach: { read: 'from-personality' },
    attachments: { kinds: ['file', 'image'] },
  },
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'Opaque attachment reference (e.g. att-0) to read an attached file.',
      },
      path: { type: 'string', description: 'File path to read (absolute or relative to cwd)' },
      start_line: { type: 'number', description: 'First line to return (1-indexed, inclusive)' },
      end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive)' },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { ref, path, start_line, end_line } = args as {
      ref?: string;
      path?: string;
      start_line?: number;
      end_line?: number;
    };

    // Resolve attachment ref → path when present.
    let resolvedPath = path;
    if (ref) {
      if (!ctx.attachments) {
        return {
          ok: false,
          error: 'No attachments available for this turn.',
          code: 'not_available',
        };
      }
      const att = await ctx.attachments.openByRef(ref);
      resolvedPath = att.path;
    }

    if (!resolvedPath) return { ok: false, error: 'path is required', code: 'input_invalid' };

    const expanded = expandPath(resolvedPath, ctx.workingDir);
    const abs = canonicalizeForRead(expanded);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    // FW-28 — snapshot mtime before reading. Stat again after; if the file
    // changed while we read it the content is ambiguous, so we surface an error
    // rather than silently recording the wrong baseline for the stale-write guard.
    let mtimeBefore: number | null = null;
    if (ctx.readMtimes) {
      try {
        mtimeBefore = await fs.mtime(abs);
      } catch (err) {
        if (isReachError(err)) return reachFailure('read', abs);
        throw err;
      }
    }

    let content: string;
    try {
      content = await fs.read(abs);
    } catch (err) {
      if (isReachError(err)) return reachFailure('read', abs);
      if (err instanceof Error && err.message.startsWith('File not found:')) {
        return { ok: false, error: `Cannot read ${abs}: file not found`, code: 'execution_failed' };
      }
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }

    if (ctx.readMtimes && mtimeBefore !== null) {
      const mtimeAfter = await fs.mtime(abs);
      if (mtimeAfter === null || mtimeAfter !== mtimeBefore) {
        return {
          ok: false,
          error: `${abs} changed during read — re-read the file before writing`,
          code: 'execution_failed',
        };
      }
      ctx.readMtimes.set(abs, { mtimeMs: mtimeBefore, readAtTurn: ctx.currentTurn });
    }

    const lines = content.split('\n');
    const total = lines.length;

    if (start_line !== undefined || end_line !== undefined) {
      const from = Math.max(1, start_line ?? 1) - 1;
      const to = Math.min(total, end_line ?? total);
      const slice = lines.slice(from, to);
      const header = `[${abs}] lines ${from + 1}–${to} of ${total}\n\n`;
      return { ok: true, value: header + slice.join('\n') };
    }

    return {
      ok: true,
      value: `[${abs}] ${total} lines\n\n${content}`,
    };
  },
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write content to a file. Creates parent directories if needed. Blocked for ~/.ethos/config.yaml and session storage.',
  toolset: 'file',
  capabilities: {
    fs_reach: { read: 'from-personality', write: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { path, content } = args as { path: string; content: string };

    if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };
    if (content === undefined)
      return { ok: false, error: 'content is required', code: 'input_invalid' };

    const abs = expandPath(path, ctx.workingDir);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    if (isWriteBlocked(abs)) {
      return {
        ok: false,
        error: `Writing to ${abs} is blocked. Use the appropriate ethos command instead.`,
        code: 'execution_failed',
      };
    }

    try {
      const stale = await checkStaleWrite(abs, ctx.readMtimes, fs);
      if (stale) return stale;

      await fs.mkdir(dirname(abs));
      await fs.write(abs, content);
      // FW-28 — update the recorded mtime after a successful write so subsequent
      // writes in the same session don't false-positive against the pre-write record.
      if (ctx.readMtimes) {
        const writtenMtime = await fs.mtime(abs);
        if (writtenMtime !== null) {
          ctx.readMtimes.set(abs, { mtimeMs: writtenMtime, readAtTurn: ctx.currentTurn });
        } else {
          ctx.readMtimes.delete(abs);
        }
      }
      return { ok: true, value: `Written ${content.length} bytes to ${abs}` };
    } catch (err) {
      if (isReachError(err)) return reachFailure('write', abs);
      return {
        ok: false,
        error: `Cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// patch_file — find old_text in file, replace with new_text
// ---------------------------------------------------------------------------

export const patchFileTool: Tool = {
  name: 'patch_file',
  description:
    'Replace an exact block of text in a file with new content. old_text must match the file content exactly (including whitespace and indentation). Use read_file first to confirm the exact text.',
  toolset: 'file',
  capabilities: {
    fs_reach: { read: 'from-personality', write: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to modify' },
      old_text: { type: 'string', description: 'Exact text to find and replace' },
      new_text: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { path, old_text, new_text } = args as {
      path: string;
      old_text: string;
      new_text: string;
    };

    if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };
    if (!old_text) return { ok: false, error: 'old_text is required', code: 'input_invalid' };

    const abs = expandPath(path, ctx.workingDir);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    if (isWriteBlocked(abs)) {
      return { ok: false, error: `Writing to ${abs} is blocked.`, code: 'execution_failed' };
    }

    try {
      const stale = await checkStaleWrite(abs, ctx.readMtimes, fs);
      if (stale) return stale;

      let content: string;
      try {
        content = await fs.read(abs);
      } catch (err) {
        if (isReachError(err)) return reachFailure('read', abs);
        if (err instanceof Error && err.message.startsWith('File not found:')) {
          return {
            ok: false,
            error: `Cannot read ${abs}: file not found`,
            code: 'execution_failed',
          };
        }
        return {
          ok: false,
          error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }

      const occurrences = countOccurrences(content, old_text);
      if (occurrences === 0) {
        return {
          ok: false,
          error: `old_text not found in ${abs}. Use read_file to verify the exact content.`,
          code: 'execution_failed',
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          error: `old_text matches ${occurrences} locations in ${abs}. Add surrounding context to make the match unique, or call patch_file once per location.`,
          code: 'execution_failed',
        };
      }

      const patched = content.replace(old_text, new_text);
      await fs.write(abs, patched);

      // FW-28 — update the recorded mtime after a successful patch.
      if (ctx.readMtimes) {
        const patchedMtime = await fs.mtime(abs);
        if (patchedMtime !== null) {
          ctx.readMtimes.set(abs, { mtimeMs: patchedMtime, readAtTurn: ctx.currentTurn });
        } else {
          ctx.readMtimes.delete(abs);
        }
      }
      return { ok: true, value: `Patched ${abs}` };
    } catch (err) {
      if (isReachError(err)) return reachFailure('write', abs);
      throw err;
    }
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

async function walkAndSearch(
  fs: ScopedFs,
  dir: string,
  pattern: string,
  glob: string | undefined,
  matches: SearchMatch[],
  maxMatches: number,
  depth: number,
): Promise<void> {
  if (depth > 6 || matches.length >= maxMatches) return;

  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await fs.listEntries(dir);
  } catch {
    // Any error in listing (reach failure, missing dir) skips the branch
    // silently — search is best-effort and continues at the next branch.
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (['node_modules', 'dist', '.git', '.turbo', 'coverage'].includes(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDir) {
      await walkAndSearch(fs, fullPath, pattern, glob, matches, maxMatches, depth + 1);
      continue;
    }

    if (glob && !matchGlob(entry.name, glob)) continue;
    if (!isTextFile(fullPath)) continue;

    let text: string;
    try {
      text = await fs.read(fullPath);
    } catch {
      continue;
    }
    if (text.length > 2 * 1024 * 1024) continue; // skip files > 2MB

    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const line = lines[i];
      if (line?.includes(pattern)) {
        matches.push({ file: fullPath, line: i + 1, content: line.trim() });
      }
    }
  }
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search for a text pattern across files in a directory. Returns file paths, line numbers, and matching lines.',
  toolset: 'file',
  maxResultChars: 20_000,
  outputIsUntrusted: true,
  capabilities: {
    fs_reach: { read: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text pattern to search for' },
      path: {
        type: 'string',
        description: 'Directory to search (defaults to working directory)',
      },
      glob: {
        type: 'string',
        description: 'File name glob filter, e.g. "*.ts" or "*.md"',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of matches to return (default 50)',
      },
    },
    required: ['pattern'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { pattern, path, glob, max_results } = args as {
      pattern: string;
      path?: string;
      glob?: string;
      max_results?: number;
    };

    if (!pattern) return { ok: false, error: 'pattern is required', code: 'input_invalid' };

    const searchDir = path ? expandPath(path, ctx.workingDir) : ctx.workingDir;
    const maxMatches = Math.min(max_results ?? 50, 200);
    const matches: SearchMatch[] = [];
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    try {
      await walkAndSearch(fs, searchDir, pattern, glob, matches, maxMatches, 0);
    } catch (err) {
      if (isReachError(err)) return reachFailure('read', searchDir);
      throw err;
    }

    if (matches.length === 0) {
      return { ok: true, value: `No matches found for "${pattern}"` };
    }

    const lines = matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
    const header = `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}":\n\n`;
    return { ok: true, value: header + lines.join('\n') };
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileTools(): Tool[] {
  return [readFileTool, writeFileTool, patchFileTool, searchFilesTool];
}
