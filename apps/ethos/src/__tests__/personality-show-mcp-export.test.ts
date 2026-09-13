// M-T8 — `ethos personality show <id>` prints the RESOLVED `mcp_export` slice.
//
// The `## MCP export` block landed with the sheet, but nothing passed it a
// resolved scope, so every sheet the CLI printed fell back to "not available in
// this rendering" — an operator could not find out from the sheet which tools a
// caller's turn would actually get. `runPersonalityShow` now resolves it via
// `resolveMcpExportScope` against the loop's own tool registry.
//
// Driven as a REAL process, the way `unknown-command.test.ts` does: the
// resolution needs the constructed loop's registry, which only exists once the
// command has built one, and `apps/ethos/src/index.ts` dispatches at module top
// level so there is no exported function to call.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

let dir: string;

async function seed(id: string, configYaml: string): Promise<void> {
  const personalityDir = join(dir, 'personalities', id);
  await mkdir(personalityDir, { recursive: true });
  await writeFile(join(personalityDir, 'config.yaml'), configYaml);
  await writeFile(join(personalityDir, 'SOUL.md'), `# ${id}\n\nI answer other apps.\n`);
  await writeFile(join(personalityDir, 'toolset.yaml'), '- read_file\n');
}

/** The `## MCP export` block of `ethos personality show <id>`, stdout only. */
async function exportBlock(id: string): Promise<string> {
  const result = await run(
    process.execPath,
    ['--import', 'tsx', join(ROOT, 'apps/ethos/src/index.ts'), 'personality', 'show', id],
    { cwd: ROOT, env: { ...process.env, ETHOS_STATE_DIR: dir, NO_COLOR: '1' }, timeout: 240_000 },
  );
  const start = result.stdout.indexOf('## MCP export');
  expect(start).toBeGreaterThan(-1);
  return result.stdout.slice(start).split('\n\n')[0] ?? '';
}

/** Both sheets, rendered once each — SEQUENTIALLY, never with `Promise.all`.
 *  Each spawn builds a real agent loop (MCP connect, tool probes, SQLite) in
 *  the SAME `ETHOS_STATE_DIR`, and two of those racing in one state dir make
 *  the `exporter` run fall back to the unresolved "not available in this
 *  rendering" variant. The renderer is fine; the concurrency was not. */
let blocks: { exported: string; private: string };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ethos-sheet-export-'));
  await writeFile(
    join(dir, 'config.yaml'),
    // `personality:` pins which loop the command builds — the default built-in
    // reaches for MCP servers that have nothing to do with this sheet. The dead
    // `baseUrl` keeps the run hermetic: `personality show` refreshes the live
    // window probe (D16), and this sheet's subject is resolved from the tool
    // registry, not from anything a provider would answer.
    [
      'schemaVersion: 1',
      'provider: anthropic',
      'baseUrl: http://127.0.0.1:1',
      'model: test',
      'personality: exporter',
      '',
    ].join('\n'),
  );
  // `terminal` is named by the declaration but is not in the toolset, so it is
  // outside the personality's reach: `expose_tools` can only ever remove reach.
  await seed(
    'exporter',
    [
      'name: Exporter',
      'mcp_export.enabled: true',
      'mcp_export.expose_tools: read_file terminal',
      'mcp_export.expose_memory: scoped',
      '',
    ].join('\n'),
  );
  await seed('private', 'name: Private\n');
  const exported = await exportBlock('exporter');
  const notExported = await exportBlock('private');
  blocks = { exported, private: notExported };
}, 300_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('ethos personality show — resolved ## MCP export block (M-T8)', () => {
  it('names the tools a caller may use and the one the declaration did not get', () => {
    const block = blocks.exported;
    expect(block).toContain('- Status: exported — `ethos mcp serve --personality exporter`');
    expect(block).toContain("- Caller's turn may use: read_file");
    expect(block).toContain("    - terminal — dropped, not in this personality's reach");
    expect(block).toContain('- Memory: scoped — personality:exporter, read-only');
    // The gap this closes: the sheet no longer says it could not resolve.
    expect(block).not.toContain('not available in this rendering');
  });

  it('still says not exported for a personality that declares no mcp_export', () => {
    const block = blocks.private;
    expect(block).toContain(
      '- Status: not exported — no other app can ask this personality anything.',
    );
    expect(block).not.toContain("Caller's turn may use");
  });
});
