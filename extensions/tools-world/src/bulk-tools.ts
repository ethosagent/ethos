// world_import, world_export, world_build.
//   - import reads its file through `ctx.scopedFs` (declared
//     `fs_reach: { read: 'from-personality' }`, as read_file does), never a raw
//     path: bulk-tools.test.ts 'import path outside fs reach is refused'.
//   - import and build are refused in a shared turn: 'import is refused in a
//     shared turn', 'world_build refused in a shared turn'.
//   - export goes through the port, so a world the turn may not see is refused
//     by WorldService: 'export respects the audience of the turn'. `save_to`
//     writes through `ctx.scopedFs` only.
//   - build is a stub on the port until plan P5 ('world_build says it is not
//     available yet in a private turn').

import type { GraphBundle, ToolContext, ToolResult } from '@ethosagent/types';
import {
  exportCsv,
  exportFactsYaml,
  exportMcpJsonl,
  importFactsYaml,
  importMcpJsonl,
  sliceBundle,
  toBundleJson,
  toGraphML,
  toMermaid,
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
      'Build a world from your own memory, past private sessions and folders you can read. Refused in a shared turn. Not available yet in this release.',
    toolset: 'world',
    maxResultChars: 4000,
    capabilities: { fs_reach: { read: 'from-personality' } },
    schema: {
      type: 'object',
      properties: {
        world: WORLD_PROP,
        folders: { type: 'array', items: { type: 'string' }, description: 'Folders to read.' },
      },
    },
    async execute(args, ctx: ToolContext) {
      if (isSharedTurn(ctx.roomAudience)) return sharedRefusal('world_build');
      const caller = callerOf(ctx);
      if (!caller) return NO_PERSONALITY;
      try {
        const w = await resolveWorld(port, caller, str(args.world));
        if (!w.ok) return fail('input_invalid', w.error);
        const folders = Array.isArray(args.folders)
          ? args.folders.filter((f): f is string => typeof f === 'string')
          : [];
        const r = await port.build(caller, w.label, { folders });
        return fail('not_available', `world_build is not available yet (${r.refused}).`);
      } catch (e) {
        return serviceError(e);
      }
    },
  };

  return [importTool, exportTool, build];
}
