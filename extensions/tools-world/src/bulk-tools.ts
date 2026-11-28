// world_import, world_export, world_build.
//   - import reads its file through `ctx.scopedFs` (declared
//     `fs_reach: { read: 'from-personality' }`, as read_file does), never a raw
//     path: bulk-tools.test.ts 'import path outside fs reach is refused'.
//   - import and build are refused in a shared turn: 'import is refused in a
//     shared turn', 'world_build refused in a shared turn'.
//   - export goes through the port, so a world the turn may not see is refused
//     by WorldService: 'export respects the audience of the turn'. `save_to`
//     writes through `ctx.scopedFs` only.
//   - build is three calls on one tool (estimate, run, save) through the port;
//     its folders are read through `ctx.scopedFs` too ('a folder outside fs
//     reach is refused' in world-build.test.ts), and the save is a proposal
//     batch on a shared world ('save on a shared world creates one batch,
//     writes nothing live'). The tool cannot see the user's yes to a save: a
//     known limit (plan O-11), the skill asks first.

import type { GraphBundle, ScopedFs, ToolContext, ToolResult } from '@ethosagent/types';
import {
  type BuildIO,
  type BuildReply,
  type BuildRequest,
  exportCsv,
  exportFactsYaml,
  exportMcpJsonl,
  importFactsYaml,
  importMcpJsonl,
  sliceBundle,
  toBundleJson,
  toGraphML,
  toMermaid,
  WorldBuildError,
  type WorldToolPort,
} from '@ethosagent/world-service';
import {
  AS_OF,
  callerOf,
  fail,
  isSharedTurn,
  NO_PERSONALITY,
  resolveWorld,
  serviceError,
  type ToolDef,
  WORLD_PROP,
} from './common';

const IMPORT_FORMATS = ['facts-yaml', 'mcp-jsonl'] as const;
const EXPORT_FORMATS = ['facts-yaml', 'json', 'graphml', 'mermaid', 'mcp-jsonl', 'csv'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Leave room under the 20k tool cap for the header line. */
const EXPORT_INLINE_CHARS = 18_000;
const SHOWN_SKIPS = 5;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const isReachError = (e: unknown): boolean =>
  e instanceof Error && e.message.startsWith('PATH_NOT_REACHABLE:');

const reachFailure = (kind: 'read' | 'write', path: string): ToolResult =>
  fail(
    'execution_failed',
    `Filesystem boundary: ${kind} of "${path}" is outside this personality's fs_reach allowlist.`,
  );

const sharedRefusal = (tool: string): ToolResult =>
  fail(
    'not_available',
    `${tool} is refused in a shared turn: it reads or writes beyond this room.`,
  );

function render(bundle: GraphBundle, format: ExportFormat): string {
  switch (format) {
    case 'facts-yaml':
      return exportFactsYaml(bundle);
    case 'json':
      return toBundleJson(bundle);
    case 'graphml':
      return toGraphML(bundle);
    case 'mermaid':
      return toMermaid(bundle);
    case 'mcp-jsonl':
      return exportMcpJsonl(bundle);
    case 'csv': {
      const { entitiesCsv, linksCsv } = exportCsv(bundle);
      return `# entities.csv\n${entitiesCsv}\n# links.csv\n${linksCsv}`;
    }
  }
}

function pickFormat<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T | undefined {
  if (v === undefined) return fallback;
  return allowed.find((f) => f === v);
}

const BUILD_ACTIONS = ['estimate', 'run', 'save'] as const;
const BUILD_CHOICES = ['all', 'sure_only', 'discard'] as const;

/** Largest folder read: files and characters per file. */
const FOLDER_MAX_FILES = 200;
const FOLDER_MAX_DEPTH = 4;
const FOLDER_FILE_CHARS = 60_000;
const TEXT_FILE = /\.(md|markdown|txt|csv|json|jsonl|ya?ml)$/i;

/** Text files under a folder, read only through the turn's own fs reach (`ctx.scopedFs`). */
function folderReader(fs: ScopedFs | undefined): BuildIO['readFolder'] {
  return async function* (root) {
    if (!fs) throw new Error(`PATH_NOT_REACHABLE: ${root}`);
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let files = 0;
    for (let next = queue.shift(); next; next = queue.shift()) {
      const entries = await fs.listEntries(next.dir);
      for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${next.dir.replace(/\/$/, '')}/${e.name}`;
        if (e.isDir) {
          if (next.depth < FOLDER_MAX_DEPTH) queue.push({ dir: path, depth: next.depth + 1 });
        } else if (TEXT_FILE.test(e.name)) {
          if (files++ >= FOLDER_MAX_FILES) return;
          yield { path, text: (await fs.read(path)).slice(0, FOLDER_FILE_CHARS) };
        }
      }
    }
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Person" -> "people", "Service" -> "services", "Category" -> "categories". */
function pluralType(type: string, n: number): string {
  const t = type.toLowerCase();
  if (n === 1) return `1 ${t}`;
  if (t === 'person') return `${n} people`;
  if (t.endsWith('y')) return `${n} ${t.slice(0, -1)}ies`;
  return `${n} ${t.endsWith('s') ? t : `${t}s`}`;
}

const dollars = (usd: number): string =>
  usd > 0 && usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`;

function describeBuild(r: BuildReply): string {
  switch (r.action) {
    case 'estimate': {
      const lines = [
        `Will read ${plural(r.memoryFiles, 'memory file', 'memory files')}, ${plural(r.sessions, 'private session', 'private sessions')}, ${plural(r.files, 'file', 'files')}. About ${dollars(r.estimateUsd)}.`,
      ];
      for (const why of r.refused) lines.push(`Skipped: ${why}.`);
      lines.push(`buildId: ${r.buildId}. Next: world_build { buildId, action: "run" }.`);
      return lines.join('\n');
    }
    case 'run': {
      const parts = Object.entries(r.entities).map(([t, n]) => pluralType(t, n));
      parts.push(plural(r.links, 'link', 'links'));
      const dup = `${plural(r.duplicates, 'duplicate', 'duplicates')} I'm unsure about`;
      const lines = [
        `${parts.join(', ')}. ${dup}, ${plural(r.conflicts, 'conflict', 'conflicts')} with your facts.`,
        `Preview: /world?build=${r.buildId}`,
      ];
      if (r.partial) {
        lines.push(
          `Stopped at the spend limit (${dollars(r.spentUsd)} spent); this is a partial result.`,
        );
      }
      lines.push(
        'Nothing is saved yet. Ask the user, then world_build { buildId, action: "save", choice: "all" | "sure_only" | "discard" }.',
      );
      return lines.join('\n');
    }
    case 'save': {
      if (r.choice === 'discard') return `Discarded build ${r.buildId}; nothing was written.`;
      const skipped =
        r.skipped > 0
          ? ` ${plural(r.skipped, 'item', 'items')} skipped (already stored or refused).`
          : '';
      return r.shared
        ? `Proposed ${plural(r.proposed, 'fact', 'facts')} to the owner of ${r.world} as one batch; nothing is live until they accept.${skipped}`
        : `Saved to ${r.world}: ${plural(r.applied, 'fact', 'facts')} written, ${plural(r.proposed, 'proposal', 'proposals')} waiting for you (conflicts with your own facts).${skipped}`;
    }
  }
}

export function createBulkTools(port: WorldToolPort): ToolDef[] {
  const importTool: ToolDef = {
    name: 'world_import',
    description: `Import a facts file into a world. "path" is read through this personality's file access, never raw. Formats: ${IMPORT_FORMATS.join(', ')} (default by extension: .jsonl is mcp-jsonl). Imported facts follow the same routing as world_assert: applied on your private world, proposed on a shared one. Refused in a shared turn.`,
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: { fs_reach: { read: 'from-personality' } },
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        path: { type: 'string', description: 'File to import.' },
        format: { type: 'string', enum: [...IMPORT_FORMATS] },
      },
      required: ['path'],
    },
    async execute(args, ctx: ToolContext) {
      if (isSharedTurn(ctx.roomAudience)) return sharedRefusal('world_import');
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const path = str(args.path);
      if (!path) return fail('input_invalid', '"path" is required.');
      const format = pickFormat(
        args.format,
        IMPORT_FORMATS,
        path.endsWith('.jsonl') ? 'mcp-jsonl' : 'facts-yaml',
      );
      if (!format)
        return fail('input_invalid', `format must be one of: ${IMPORT_FORMATS.join(', ')}`);
      if (!ctx.scopedFs) {
        return fail('not_available', 'Filesystem capability not configured for this personality.');
      }
      let text: string;
      try {
        text = await ctx.scopedFs.read(path);
      } catch (e) {
        if (isReachError(e)) return reachFailure('read', path);
        return fail(
          'execution_failed',
          `could not read "${path}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      try {
        const w = await resolveWorld(port, caller, str(args.world));
        if (!w.ok) return fail('input_invalid', w.error);
        const now = new Date().toISOString();
        let bundle: GraphBundle;
        if (format === 'facts-yaml') {
          const r = importFactsYaml(text, w.id, { now });
          if (!r.ok) {
            const first = r.errors.slice(0, SHOWN_SKIPS).map((e) => `line ${e.line}: ${e.message}`);
            return fail('input_invalid', `${path} is not valid facts YAML:\n${first.join('\n')}`);
          }
          bundle = r.bundle;
        } else {
          bundle = importMcpJsonl(text, { world: w.id, sourceRef: `import:${path}`, now }).bundle;
        }
        const out = await port.importBundle(caller, w.label, bundle);
        const lines = [
          `read ${out.report.entities} entities · ${out.report.attributes} attributes · ${out.report.edges} edges from ${path}`,
          `applied ${out.applied} · proposed ${out.proposed} · skipped ${out.report.skipped.length}`,
        ];
        for (const s of out.report.skipped.slice(0, SHOWN_SKIPS)) {
          lines.push(`skipped line ${s.line}: ${s.reason}`);
        }
        if (out.proposed > 0) lines.push("Proposed facts wait for the owner's decision.");
        const nothing = out.applied + out.proposed === 0 && out.report.skipped.length > 0;
        return nothing
          ? fail('input_invalid', lines.join('\n'))
          : { ok: true, value: lines.join('\n') };
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  const exportTool: ToolDef = {
    name: 'world_export',
    description: `Export a world as text. Formats: ${EXPORT_FORMATS.join(', ')} (default facts-yaml). "as_of" exports the world as it was on a date. Long output is cut; pass "save_to" (a path in your files) to write it all there instead. Only worlds visible to this turn can be exported.`,
    toolset: 'world',
    maxResultChars: 20_000,
    capabilities: { fs_reach: { write: 'from-personality' } },
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        format: { type: 'string', enum: [...EXPORT_FORMATS] },
        as_of: { type: 'string', description: 'ISO date (YYYY-MM-DD). Default now.' },
        save_to: {
          type: 'string',
          description: 'Write the export to this file instead of returning it.',
        },
      },
    },
    async execute(args, ctx: ToolContext) {
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const format = pickFormat(args.format, EXPORT_FORMATS, 'facts-yaml');
      if (!format)
        return fail('input_invalid', `format must be one of: ${EXPORT_FORMATS.join(', ')}`);
      const asOf = str(args.as_of);
      if (asOf !== undefined && !AS_OF.test(asOf)) {
        return fail('input_invalid', 'as_of must be an ISO date like 2026-11-20.');
      }
      const saveTo = str(args.save_to);
      if (saveTo !== undefined && !ctx.scopedFs) {
        return fail('not_available', 'Filesystem capability not configured for this personality.');
      }
      try {
        const w = await resolveWorld(port, caller, str(args.world));
        if (!w.ok) return fail('input_invalid', w.error);
        const bundle = await port.exportBundle(caller, w.label);
        const text = render(asOf ? sliceBundle(bundle, { asOf }) : bundle, format);
        const head = `${w.label} · ${format} · ${bundle.entities.length} entities`;
        if (saveTo !== undefined && ctx.scopedFs) {
          try {
            await ctx.scopedFs.write(saveTo, text);
          } catch (e) {
            if (isReachError(e)) return reachFailure('write', saveTo);
            throw e;
          }
          return { ok: true, value: `${head}: saved to ${saveTo}` };
        }
        if (text.length > EXPORT_INLINE_CHARS) {
          return {
            ok: true,
            value: `${head} (cut at ${EXPORT_INLINE_CHARS} chars; use save_to for all of it)\n${text.slice(0, EXPORT_INLINE_CHARS)}`,
          };
        }
        return { ok: true, value: `${head}\n${text}` };
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  const build: ToolDef = {
    name: 'world_build',
    description:
      'Build a world from your own memory files, past private sessions and folders you can read, in three calls. 1) action "estimate" (optional "folders") counts what would be read and prices it. 2) action "run" with "buildId" extracts and stages a preview; nothing is written yet. 3) action "save" with "buildId" and choice "all", "sure_only" or "discard": a private world gets your agent facts (conflicts with your own facts become proposals), a shared world gets one proposal batch for the owner. Ask the user before you save. Refused in a shared turn.',
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: { fs_reach: { read: 'from-personality' } },
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...BUILD_ACTIONS] },
        world: WORLD_PROP,
        folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'estimate only: folders to read, through your file access.',
        },
        buildId: { type: 'string', description: 'run and save: the id estimate returned.' },
        choice: { type: 'string', enum: [...BUILD_CHOICES], description: 'save only.' },
      },
      required: ['action'],
    },
    async execute(args, ctx: ToolContext) {
      if (isSharedTurn(ctx.roomAudience)) return sharedRefusal('world_build');
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      const action = BUILD_ACTIONS.find((a) => a === args.action);
      if (!action)
        return fail('input_invalid', `action must be one of: ${BUILD_ACTIONS.join(', ')}`);
      const buildId = str(args.buildId);
      let req: BuildRequest;
      if (action === 'estimate') {
        const folders = Array.isArray(args.folders)
          ? args.folders.filter((f): f is string => typeof f === 'string' && f !== '')
          : [];
        if (folders.length > 0 && !ctx.scopedFs) {
          return fail(
            'not_available',
            'Filesystem capability not configured for this personality.',
          );
        }
        req = { action, folders };
      } else if (buildId === undefined) {
        return fail('input_invalid', '"buildId" is required: call estimate first.');
      } else if (action === 'run') {
        req = { action, buildId };
      } else {
        const choice = BUILD_CHOICES.find((c) => c === args.choice);
        if (!choice) {
          return fail('input_invalid', `choice must be one of: ${BUILD_CHOICES.join(', ')}`);
        }
        req = { action, buildId, choice };
      }
      try {
        const name =
          action === 'estimate' ? await resolveWorld(port, caller, str(args.world)) : null;
        if (name && !name.ok) return fail('input_invalid', name.error);
        const world = name ? name.label : (str(args.world) ?? null);
        const io: BuildIO = { readFolder: folderReader(ctx.scopedFs) };
        const r = await port.build(caller, world, req, io);
        if (!('action' in r)) {
          return fail(
            'not_available',
            'world_build is not available: no first-build runtime is composed.',
          );
        }
        return { ok: true, value: describeBuild(r) };
      } catch (e) {
        if (e instanceof WorldBuildError) return fail('input_invalid', e.message);
        return serviceError(e);
      }
    },
  };

  return [importTool, exportTool, build];
}
