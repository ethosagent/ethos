// P7 — CLI surface: `--help` and `--version` output (spawned under a hermetic env) and
// the command names of the dispatcher's `switch (effectiveCommand)` case labels, read
// via the TS AST. Per-command `--help` is NOT snapshotted: not every command prints
// and exits without side effects (`chat` and `setup` can go interactive).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertParity, type HermeticEnv, withHermeticEnv } from './harness';

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const CLI_ENTRY = join(REPO_ROOT, 'apps/ethos/src/index.ts');

let env: HermeticEnv;
beforeAll(() => {
  env = withHermeticEnv();
});
afterAll(() => env.restore());

function runCli(args: string[]): string {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: env.home,
    ETHOS_STATE_DIR: env.stateDir,
    ETHOS_VERSION: 'parity',
    NO_COLOR: '1',
    COLUMNS: '100',
  };
  return execFileSync(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Case labels of every `switch (effectiveCommand)` at any depth of the entry file. */
function dispatcherCases(): string[] {
  const text = readFileSync(CLI_ENTRY, 'utf8');
  const sf = ts.createSourceFile(CLI_ENTRY, text, ts.ScriptTarget.Latest, true);
  const labels: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && node.expression.getText(sf) === 'effectiveCommand') {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
          labels.push(clause.expression.text);
        } else if (ts.isDefaultClause(clause)) {
          labels.push('<default>');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return labels;
}

describe('P7 CLI surface parity', () => {
  it('matches the CLI fixture', () => {
    assertParity('p7-cli', {
      help: runCli(['--help']),
      version: runCli(['--version']),
      commands: dispatcherCases(),
    });
  }, 120_000);
});
