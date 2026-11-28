// `ethos world` — the owner's command line onto the world model (plan world-model 7.7).
//
//   ethos world list [--json]
//   ethos world create <slug> [--template company|watchlist] [--audience owner_only|shareable] [--title "<t>"]
//   ethos world show <slug> [--tree] [--as-of <date>] [--entity <name>] [--json]
//   ethos world export <slug> --yaml|--csv|--json|--graphml|--mermaid|--jsonl [--as-of <date>]
//   ethos world import <slug> <file>
//   ethos world proposals <slug> [--json]
//   ethos world accept <proposalId> | reject <proposalId> [--reason "<text>"]
//   ethos world grant <slug> <personality> --read|--propose · revoke <slug> <personality>
//   ethos world mount <personality> <slug> --mode read|propose [--as <alias>] · unmount <personality> <slug>
//   ethos world purge <slug> [--entity <name>] --reason "<text>" [--yes]
//
// `<slug>` is a shared world; `personality:<id>` names a personality's private world. Exit 0 on
// success; any failure is an `EthosError` (WORLD_NOT_FOUND, WORLD_SCHEMA_INVALID, WORLD_CONFLICT,
// INVALID_INPUT) that index.ts renders and exits 1 on, never a raw `Error`.
//
// The CLI is an owner surface: it holds no graph backend. Facts go through WorldService owner
// methods, schema.yaml through WorldSchemaService, world.yaml and worlds.yaml through
// WorldConfigService, the single writers (plan Global Constraints). The runtime is the loop's ONE
// world runtime (`CreateAgentLoopResult.worlds`), so a world that is not `world.enabled` answers
// NOT_CONFIGURED. `export` writes to stdout only (world-cli.test.ts 'export writes only to
// stdout'). `purge` refuses without a terminal unless `--yes` (world-cli.test.ts 'purge without
// --yes refuses in a non-TTY').
//
// Pinned by apps/ethos/src/commands/__tests__/world-cli.test.ts.

import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { EthosError, type GraphBundle, IdValidationError, type WorldId } from '@ethosagent/types';
import { type WorldRuntime, worldOwner } from '@ethosagent/wiring';
import { worldTreeText } from '../lib/world-tree-source';
import { cleanLine } from './personality-amendments';

const {
  bundleFromText,
  exportCsv,
  exportFactsYaml,
  exportMcpJsonl,
  findTreeEntity,
  importFormatOf,
  isTemplateName,
  loadTemplate,
  parseWorldId,
  sliceBundle,
  TEMPLATE_AUDIENCE,
  toBundleJson,
  toGraphML,
  toMermaid,
  WorldConfigError,
  WorldServiceError,
  worldSlug,
} = worldOwner;

export type WorldCliRuntime = Pick<WorldRuntime, 'service' | 'schema' | 'configService'>;

export interface WorldCliDeps {
  runtime: WorldCliRuntime;
  /** One line; a newline is added. */
  out(line: string): void;
  /** Raw text to stdout, no newline added (the `export` body). */
  write(text: string): void;
  /** The text of a file the user named, or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Whether a personality with this id exists (built-in or user). */
  personalityExists(id: string): Promise<boolean>;
  /** Both stdin and stdout are terminals. */
  isTty: boolean;
  /** Ask a yes/no question on the terminal. */
  confirm(question: string): Promise<boolean>;
  /** The audit label recorded as the writer, e.g. `cli:alice`. */
  by: string;
  now?: () => Date;
}

const USAGE = [
  'Usage: ethos world <command>',
  '',
  '  list [--json]                                          every shared world',
  '  create <slug> [--template company|watchlist] [--audience owner_only|shareable] [--title "<t>"]',
  '  show <slug> [--tree] [--as-of <date>] [--entity <name>] [--json]',
  '  export <slug> --yaml|--csv|--json|--graphml|--mermaid|--jsonl [--as-of <date>]   (stdout)',
  '  import <slug> <file>                                   .yaml .json .jsonl .csv',
  '  proposals <slug> [--json]                              pending proposals',
  '  accept <proposalId>                                    replay a proposal as written',
  '  reject <proposalId> [--reason "<text>"]',
  '  grant <slug> <personality> --read|--propose            revoke <slug> <personality>',
  '  mount <personality> <slug> --mode read|propose [--as <alias>]   unmount <personality> <slug>',
  '  purge <slug> [--entity <name>] --reason "<text>" [--yes]        the only delete',
  '',
  "<slug> may be personality:<id> for a personality's private world.",
];

/** Flags that take a value, so the value is never mistaken for a positional. */
const VALUE_FLAGS = new Set([
  '--template',
  '--audience',
  '--title',
  '--as-of',
  '--entity',
  '--reason',
  '--mode',
  '--as',
]);

/** Build the loop, hand its world runtime to the command, release the loop. */
export async function runWorld(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    for (const line of USAGE) console.log(line);
    return;
  }
  const { loadRequiredConfig } = await import('../managed-mode');
  const { createAgentLoop, getStorage } = await import('../wiring');
  const { releaseCommandRuntime } = await import('../lib/release-command-runtime');
  const config = await loadRequiredConfig();
  const runtime = await createAgentLoop(config);
  try {
    const { worlds } = runtime;
    if (!worlds) {
      throw new EthosError({
        code: 'NOT_CONFIGURED',
        cause: 'The world model is not enabled',
        action: 'Set world.enabled: true in config.yaml, then retry.',
      });
    }
    const storage = getStorage();
    await runWorldCommand(args, {
      runtime: worlds,
      out: (line) => console.log(line),
      write: (text) => {
        process.stdout.write(text);
      },
      readText: (path) => storage.read(path),
      personalityExists: async (id) => runtime.personalities.get(id) !== undefined,
      isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: askYesNo,
      by: operatorLabel(),
    });
  } finally {
    await releaseCommandRuntime(runtime, { label: 'world agent loop', drainMs: 0 });
  }
}

/** The command body, with every dependency injected. Throws `EthosError` on any failure. */
export async function runWorldCommand(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case 'list':
        return await list(rest, deps);
      case 'create':
        return await create(rest, deps);
      case 'show':
        return await show(rest, deps);
      case 'export':
        return await exportWorld(rest, deps);
      case 'import':
        return await importWorld(rest, deps);
      case 'proposals':
        return await proposals(rest, deps);
      case 'accept':
        return await accept(rest, deps);
      case 'reject':
        return await reject(rest, deps);
      case 'grant':
        return await grant(rest, deps);
      case 'revoke':
        return await revoke(rest, deps);
      case 'mount':
        return await mount(rest, deps);
      case 'unmount':
        return await unmount(rest, deps);
      case 'purge':
        return await purge(rest, deps);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        for (const line of USAGE) deps.out(line);
        return;
      default:
        throw invalid(`Unknown subcommand: ${cleanLine(sub)}`, 'Run `ethos world help`.');
    }
  } catch (e) {
    throw translate(e);
  }
}

// --- Errors ------------------------------------------------------------------

function invalid(cause: string, action: string): EthosError {
  return new EthosError({ code: 'INVALID_INPUT', cause, action });
}

function notFound(cause: string, action = 'Run `ethos world list` for the worlds.'): EthosError {
  return new EthosError({ code: 'WORLD_NOT_FOUND', cause, action });
}

/** The service's own errors become the registered codes; an EthosError passes through. */
function translate(e: unknown): unknown {
  if (e instanceof EthosError) return e;
  if (e instanceof IdValidationError) {
    return invalid(cleanLine(e.message), 'Use a lowercase slug: a-z, 0-9, _ and -.');
  }
  if (e instanceof WorldConfigError) {
    return new EthosError({
      code: 'WORLD_SCHEMA_INVALID',
      cause: cleanLine(e.message),
      action: 'Fix the named line and retry.',
    });
  }
  if (e instanceof WorldServiceError) {
    return e.code === 'not_pending' || e.code === 'not_mounted'
      ? notFound(cleanLine(e.message), 'Run `ethos world proposals <slug>` for the pending ids.')
      : new EthosError({
          code: 'WORLD_CONFLICT',
          cause: cleanLine(e.message),
          action: 'Check the world and retry.',
        });
  }
  return e;
}

/** A refusal reason from the service (`<code>: <text>`) as the registered error. */
function refusalError(reason: string): EthosError {
  const text = cleanLine(reason);
  if (reason.startsWith('not_found') || reason.startsWith('not_pending')) {
    return notFound(text, 'Run `ethos world proposals <slug>` for the pending ids.');
  }
  if (reason.startsWith('closed') || reason.startsWith('already_authoritative')) {
    return new EthosError({
      code: 'WORLD_CONFLICT',
      cause: text,
      action: 'Re-read the world with `ethos world show` and retry.',
    });
  }
  return new EthosError({
    code: 'WORLD_SCHEMA_INVALID',
    cause: text,
    action: 'Fix the fact or the schema and retry.',
  });
}

// --- Argument helpers --------------------------------------------------------

/** `--flag value` or `--flag=value`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

function need(args: readonly string[], count: number, usage: string): string[] {
  const p = positionals(args);
  if (p.length < count)
    throw invalid(`Missing argument. Usage: ethos world ${usage}`, 'Run `ethos world help`.');
  return p;
}

/** A required positional; `need` guarantees it exists, so a hole is a programming error surfaced as usage. */
function at(p: readonly string[], i: number, usage: string): string {
  const v = p[i];
  if (v === undefined)
    throw invalid(`Missing argument. Usage: ethos world ${usage}`, 'Run `ethos world help`.');
  return v;
}

function asOfOf(args: readonly string[]): string | undefined {
  const v = flagValue(args, '--as-of');
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw invalid(`--as-of ${cleanLine(v)} is not a date`, 'Use YYYY-MM-DD or an ISO time.');
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : new Date(t).toISOString();
}

/** `acme` -> world:acme; `personality:<id>` as given. Refuses a world that does not exist. */
async function known(input: string, deps: WorldCliDeps): Promise<WorldId> {
  let id: WorldId;
  try {
    id = input.includes(':') ? parseWorldId(input) : parseWorldId(`world:${input}`);
  } catch (e) {
    throw invalid(cleanLine(e instanceof Error ? e.message : String(e)), 'Use a lowercase slug.');
  }
  if (id.startsWith('personality:')) {
    if (!(await deps.personalityExists(worldSlug(id)))) {
      throw notFound(`No personality ${cleanLine(worldSlug(id))}`, 'Run `ethos personality list`.');
    }
  } else if ((await deps.runtime.configService.readWorld(worldSlug(id))) === null) {
    throw notFound(`No world ${cleanLine(input)}`);
  }
  return id;
}

async function requirePersonality(id: string, deps: WorldCliDeps): Promise<void> {
  if (!(await deps.personalityExists(id))) {
    throw notFound(`No personality ${cleanLine(id)}`, 'Run `ethos personality list`.');
  }
}

const liveEntities = (b: GraphBundle) =>
  b.entities.filter((e) => e.retiredAt === null && e.mergedInto === null);

// --- Subcommands -------------------------------------------------------------

async function list(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const { service, configService } = deps.runtime;
  const worlds = await configService.listWorlds();
  const rows = [];
  for (const w of worlds.values()) {
    const id = `world:${w.id}` as WorldId;
    const bundle = await service.ownerExport(id);
    rows.push({
      slug: w.id,
      title: w.title,
      audience: w.audience,
      backend: w.backend,
      entities: liveEntities(bundle).length,
      pendingProposals: service.ownerPendingCount(id),
    });
  }
  if (args.includes('--json')) {
    deps.out(JSON.stringify({ worlds: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    deps.out('No worlds. Create one with: ethos world create <slug> --template company');
    return;
  }
  for (const line of table(
    ['SLUG', 'TITLE', 'AUDIENCE', 'BACKEND', 'ENTITIES', 'PENDING'],
    rows.map((r) =>
      [r.slug, r.title, r.audience, r.backend, String(r.entities), String(r.pendingProposals)].map(
        cleanLine,
      ),
    ),
  )) {
    deps.out(line);
  }
}

async function create(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const slug = at(need(args, 1, 'create <slug>'), 0, 'create <slug>');
  const templateArg = flagValue(args, '--template');
  if (templateArg !== undefined && !isTemplateName(templateArg)) {
    throw new EthosError({
      code: 'WORLD_SCHEMA_INVALID',
      cause: `Unknown template ${cleanLine(templateArg)}`,
      action: 'Use --template company or --template watchlist.',
    });
  }
  const audienceArg = flagValue(args, '--audience');
  if (audienceArg !== undefined && audienceArg !== 'owner_only' && audienceArg !== 'shareable') {
    throw invalid(
      `--audience ${cleanLine(audienceArg)} is not valid`,
      'Use owner_only or shareable.',
    );
  }
  const { configService, schema } = deps.runtime;
  if ((await configService.readWorld(slug)) !== null) {
    throw new EthosError({
      code: 'WORLD_CONFLICT',
      cause: `World ${cleanLine(slug)} already exists`,
      action: 'Pick another slug, or use `ethos world show` to inspect it.',
    });
  }
  const audience = audienceArg ?? (templateArg ? TEMPLATE_AUDIENCE[templateArg] : 'owner_only');
  const file = await configService.writeWorld(
    { id: slug, title: flagValue(args, '--title') ?? slug, audience },
    { by: deps.by },
  );
  const id = `world:${file.id}` as WorldId;
  if (templateArg !== undefined) {
    const saved = await schema.saveYaml(id, loadTemplate(templateArg), 0);
    if (!saved.ok) {
      throw new EthosError({
        code: saved.kind === 'conflict' ? 'WORLD_CONFLICT' : 'WORLD_SCHEMA_INVALID',
        cause: cleanLine(saved.error),
        action: `The world ${slug} was created without a schema; fix it and retry.`,
      });
    }
  }
  deps.out(
    `Created world ${file.id} (${audience})${templateArg ? ` from the ${templateArg} template` : ''}.`,
  );
}

async function show(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const world = await known(at(need(args, 1, 'show <slug>'), 0, 'show <slug>'), deps);
  const { service, schema } = deps.runtime;
  const asOf = asOfOf(args);
  const entityArg = flagValue(args, '--entity');
  const whole = await service.ownerExport(world);
  const bundle = sliceBundle(whole, asOf === undefined ? {} : { asOf });

  if (args.includes('--tree')) {
    if (entityArg !== undefined && !findTreeEntity(bundle, entityArg)) {
      throw notFound(`No entity ${cleanLine(entityArg)} in ${cleanLine(worldSlug(world))}`);
    }
    deps.out(
      await worldTreeText(service, world, {
        ...(asOf === undefined ? {} : { asOf }),
        ...(entityArg === undefined ? {} : { entity: entityArg }),
      }),
    );
    return;
  }

  if (entityArg !== undefined) {
    const e = findTreeEntity(bundle, entityArg);
    if (!e) throw notFound(`No entity ${cleanLine(entityArg)} in ${cleanLine(worldSlug(world))}`);
    const name = (id: string) => bundle.entities.find((x) => x.id === id)?.name ?? id;
    const detail = {
      id: e.id,
      type: e.type,
      name: e.name,
      aliases: e.aliases,
      attributes: bundle.attributes
        .filter((a) => a.entityId === e.id)
        .map((a) => ({ key: a.key, value: a.value })),
      edges: bundle.edges
        .filter((x) => x.fromId === e.id || x.toId === e.id)
        .map((x) => ({
          type: x.type,
          direction: x.fromId === e.id ? 'out' : 'in',
          other: name(x.fromId === e.id ? x.toId : x.fromId),
        })),
    };
    if (args.includes('--json')) {
      deps.out(JSON.stringify(detail, null, 2));
      return;
    }
    deps.out(`${cleanLine(e.name)} (${cleanLine(e.type)}) ${e.id}`);
    for (const a of detail.attributes)
      deps.out(`  ${cleanLine(a.key)}: ${cleanLine(JSON.stringify(a.value))}`);
    for (const x of detail.edges) {
      deps.out(
        `  ${x.direction === 'out' ? '->' : '<-'} ${cleanLine(x.type)} ${cleanLine(x.other)}`,
      );
    }
    return;
  }

  const file = world.startsWith('world:')
    ? await deps.runtime.configService.readWorld(worldSlug(world))
    : null;
  const entities = liveEntities(bundle);
  const byType = new Map<string, number>();
  for (const e of entities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const summary = {
    id: world,
    title: file?.title ?? `${worldSlug(world)} (private)`,
    audience: file?.audience ?? 'owner_only',
    backend: file?.backend ?? 'sqlite',
    readers: file?.readers ?? [],
    proposers: file?.proposers ?? [],
    schemaVersion: (await schema.load(world)).version,
    entities: Object.fromEntries([...byType].sort(([a], [b]) => (a < b ? -1 : 1))),
    liveEdges: bundle.edges.filter((x) => x.validTo === null && x.retiredAt === null).length,
    pendingProposals: service.ownerPendingCount(world),
  };
  if (args.includes('--json')) {
    deps.out(JSON.stringify(summary, null, 2));
    return;
  }
  deps.out(`${cleanLine(summary.id)}  ${cleanLine(summary.title)}`);
  deps.out(
    `  audience ${summary.audience}, backend ${cleanLine(summary.backend)}, schema v${summary.schemaVersion}`,
  );
  deps.out(`  readers: ${summary.readers.map(cleanLine).join(', ') || '(none)'}`);
  deps.out(`  proposers: ${summary.proposers.map(cleanLine).join(', ') || '(none)'}`);
  deps.out(
    `  ${entities.length} entities (${[...byType].map(([t, n]) => `${cleanLine(t)} ${n}`).join(', ') || 'none'}), ${summary.liveEdges} live edges`,
  );
  deps.out(`  ${summary.pendingProposals} pending proposals`);
}

type ExportFormat = 'facts-yaml' | 'json' | 'graphml' | 'mermaid' | 'mcp-jsonl' | 'csv';

const EXPORT_FLAGS: ReadonlyArray<[string, ExportFormat]> = [
  ['--yaml', 'facts-yaml'],
  ['--csv', 'csv'],
  ['--json', 'json'],
  ['--graphml', 'graphml'],
  ['--mermaid', 'mermaid'],
  ['--jsonl', 'mcp-jsonl'],
];

async function exportWorld(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const world = await known(
    at(need(args, 1, 'export <slug> --yaml|...'), 0, 'export <slug>'),
    deps,
  );
  const formats = EXPORT_FLAGS.filter(([flag]) => args.includes(flag)).map(([, f]) => f);
  const format = formats[0];
  if (format === undefined || formats.length > 1) {
    throw invalid(
      'Name exactly one format',
      'Use one of --yaml --csv --json --graphml --mermaid --jsonl.',
    );
  }
  const asOf = asOfOf(args);
  const whole = await deps.runtime.service.ownerExport(world);
  const bundle = asOf === undefined ? whole : sliceBundle(whole, { asOf });
  switch (format) {
    case 'facts-yaml':
      return deps.write(exportFactsYaml(bundle));
    case 'json':
      return deps.write(`${toBundleJson(bundle)}\n`);
    case 'graphml':
      return deps.write(toGraphML(bundle));
    case 'mermaid':
      return deps.write(`${toMermaid(bundle)}\n`);
    case 'mcp-jsonl':
      return deps.write(exportMcpJsonl(bundle));
    case 'csv': {
      const { entitiesCsv, linksCsv } = exportCsv(bundle);
      return deps.write(`# entities.csv\n${entitiesCsv}\n# links.csv\n${linksCsv}\n`);
    }
  }
}

async function importWorld(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const p = need(args, 2, 'import <slug> <file>');
  const world = await known(at(p, 0, 'import <slug> <file>'), deps);
  const file = at(p, 1, 'import <slug> <file>');
  const format = importFormatOf(file);
  if (!format) {
    throw invalid(
      `Cannot tell the format of ${cleanLine(file)}`,
      'Use a .yaml, .json, .jsonl or .csv file.',
    );
  }
  const text = await deps.readText(file);
  if (text === null) {
    throw new EthosError({
      code: 'FILE_NOT_FOUND',
      cause: `${cleanLine(file)} does not exist`,
      action: 'Check the path and retry.',
    });
  }
  const loaded = await deps.runtime.schema.load(world);
  const made = bundleFromText(format, text, {
    world,
    schema: loaded.schema,
    by: deps.by,
    now: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (!made.ok) {
    throw new EthosError({
      code: 'WORLD_SCHEMA_INVALID',
      cause: cleanLine(made.error),
      action: 'Fix the file and retry; nothing was imported.',
    });
  }
  const out = await deps.runtime.service.ownerImport(world, made.bundle, deps.by);
  const skipped = [...out.report.skipped, ...made.skipped];
  deps.out(
    `Imported ${out.report.entities} entities, ${out.report.attributes} attributes, ${out.report.edges} edges into ${cleanLine(worldSlug(world))}` +
      `${out.proposed > 0 ? ` (${out.proposed} proposed)` : ''}${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}.`,
  );
  for (const s of skipped.slice(0, 20))
    deps.out(`  skipped line ${s.line}: ${cleanLine(s.reason)}`);
}

async function proposals(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const world = await known(at(need(args, 1, 'proposals <slug>'), 0, 'proposals <slug>'), deps);
  const rows = deps.runtime.service.ownerProposals({ world, status: 'pending' });
  if (args.includes('--json')) {
    deps.out(JSON.stringify({ proposals: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    deps.out('No pending proposals.');
    return;
  }
  for (const line of table(
    ['ID', 'KIND', 'BY', 'SUMMARY'],
    rows.map((r) => [r.id, r.kind, r.proposedBy, r.summary].map(cleanLine)),
  )) {
    deps.out(line);
  }
  deps.out('');
  deps.out('Decide with: ethos world accept <id> | ethos world reject <id> [--reason "<text>"]');
}

async function accept(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const id = at(need(args, 1, 'accept <proposalId>'), 0, 'accept <proposalId>');
  const out = await deps.runtime.service.acceptProposal(id, deps.by);
  const refused = out.refused[0];
  if (refused) throw refusalError(refused.reason);
  deps.out(`Accepted ${cleanLine(id)}: ${out.applied.length} facts written.`);
}

async function reject(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const id = at(need(args, 1, 'reject <proposalId>'), 0, 'reject <proposalId>');
  await deps.runtime.service.rejectProposal(id, deps.by, flagValue(args, '--reason'));
  deps.out(`Rejected ${cleanLine(id)}; it will not be proposed again.`);
}

async function readWorldFile(slug: string, deps: WorldCliDeps) {
  const file = await deps.runtime.configService.readWorld(slug);
  if (file === null) throw notFound(`No world ${cleanLine(slug)}`);
  return file;
}

async function grant(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const usage = 'grant <slug> <personality> --read|--propose';
  const p = need(args, 2, usage);
  const slug = at(p, 0, usage);
  const personality = at(p, 1, usage);
  const mode = args.includes('--propose')
    ? 'proposers'
    : args.includes('--read')
      ? 'readers'
      : null;
  if (args.includes('--propose') && args.includes('--read')) {
    throw invalid(
      'Name one of --read or --propose',
      'Use --propose to let it propose; that includes reading.',
    );
  }
  if (mode === null) throw invalid('Name --read or --propose', `Usage: ethos world ${usage}`);
  await requirePersonality(personality, deps);
  const file = await readWorldFile(slug, deps);
  if (file[mode].includes(personality)) {
    deps.out(`${cleanLine(personality)} is already in ${cleanLine(slug)} ${mode}.`);
    return;
  }
  await deps.runtime.configService.writeWorld(
    { ...file, [mode]: [...file[mode], personality] },
    { by: deps.by },
  );
  deps.out(
    `Granted ${cleanLine(personality)} ${mode === 'readers' ? 'read' : 'propose'} on ${cleanLine(slug)}.`,
  );
}

async function revoke(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const usage = 'revoke <slug> <personality>';
  const p = need(args, 2, usage);
  const slug = at(p, 0, usage);
  const personality = at(p, 1, usage);
  const file = await readWorldFile(slug, deps);
  if (!file.readers.includes(personality) && !file.proposers.includes(personality)) {
    throw notFound(
      `${cleanLine(personality)} has no grant on ${cleanLine(slug)}`,
      `Run \`ethos world show ${slug}\`.`,
    );
  }
  await deps.runtime.configService.writeWorld(
    {
      ...file,
      readers: file.readers.filter((r) => r !== personality),
      proposers: file.proposers.filter((r) => r !== personality),
    },
    { by: deps.by },
  );
  deps.out(`Revoked ${cleanLine(personality)} on ${cleanLine(slug)}.`);
}

async function mount(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const usage = 'mount <personality> <slug> --mode read|propose [--as <alias>]';
  const p = need(args, 2, usage);
  const personality = at(p, 0, usage);
  const slug = at(p, 1, usage);
  const mode = flagValue(args, '--mode');
  if (mode !== 'read' && mode !== 'propose') {
    throw invalid('--mode read or --mode propose is required', `Usage: ethos world ${usage}`);
  }
  const alias = flagValue(args, '--as');
  await requirePersonality(personality, deps);
  await readWorldFile(slug, deps);
  const current = await deps.runtime.configService.readMounts(personality);
  const next = [
    ...current.mounts.filter((m) => m.world !== slug),
    { world: slug, mode, ...(alias ? { as: alias } : {}) },
  ];
  await deps.runtime.configService.writeMounts(personality, { mounts: next }, { by: deps.by });
  deps.out(`Mounted ${cleanLine(slug)} on ${cleanLine(personality)} (${mode}).`);
  const file = await readWorldFile(slug, deps);
  if (!file.readers.includes(personality) && !file.proposers.includes(personality)) {
    deps.out(
      `Note: the mount is inert until the world grants it: ethos world grant ${cleanLine(slug)} ${cleanLine(personality)} --read`,
    );
  }
}

async function unmount(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const usage = 'unmount <personality> <slug>';
  const p = need(args, 2, usage);
  const personality = at(p, 0, usage);
  const slug = at(p, 1, usage);
  await requirePersonality(personality, deps);
  const current = await deps.runtime.configService.readMounts(personality);
  if (!current.mounts.some((m) => m.world === slug)) {
    throw notFound(
      `${cleanLine(personality)} does not mount ${cleanLine(slug)}`,
      `Run \`ethos world show ${slug}\`.`,
    );
  }
  await deps.runtime.configService.writeMounts(
    personality,
    { mounts: current.mounts.filter((m) => m.world !== slug) },
    { by: deps.by },
  );
  deps.out(`Unmounted ${cleanLine(slug)} from ${cleanLine(personality)}.`);
}

async function purge(args: readonly string[], deps: WorldCliDeps): Promise<void> {
  const usage = 'purge <slug> [--entity <name>] --reason "<text>"';
  const world = await known(at(need(args, 1, usage), 0, usage), deps);
  const reason = flagValue(args, '--reason');
  if (!reason || reason.trim() === '') {
    throw invalid('--reason is required: a purge is recorded', `Usage: ethos world ${usage}`);
  }
  const entityArg = flagValue(args, '--entity');
  let scope: { entityId?: string } = {};
  let target = `all of ${worldSlug(world)}`;
  if (entityArg !== undefined) {
    const e = findTreeEntity(await deps.runtime.service.ownerExport(world), entityArg);
    if (!e) throw notFound(`No entity ${cleanLine(entityArg)} in ${cleanLine(worldSlug(world))}`);
    scope = { entityId: e.id };
    target = `${e.name} (${e.type}) in ${worldSlug(world)}`;
  }
  if (!args.includes('--yes')) {
    if (!deps.isTty) {
      throw invalid(
        'purge needs a terminal to confirm, and stdin or stdout is not one',
        'Re-run in a terminal, or pass --yes.',
      );
    }
    if (
      !(await deps.confirm(
        `Permanently delete ${cleanLine(target)}? This cannot be undone. [y/N] `,
      ))
    ) {
      deps.out('Cancelled; nothing was deleted.');
      return;
    }
  }
  const out = await deps.runtime.service.purge(world, scope, reason, deps.by);
  deps.out(`Purged ${out.removed} rows from ${cleanLine(target)}.`);
}

// --- Output and terminal helpers ----------------------------------------------

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function operatorLabel(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}
