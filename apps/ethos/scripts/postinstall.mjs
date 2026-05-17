#!/usr/bin/env node
//
// Welcome banner printed after `npm install -g @ethosagent/cli` (or a local
// install). Runs ONLY when:
//   - The install is global OR the consumer's INIT_CWD points to a project
//     that explicitly depends on @ethosagent/cli (i.e. someone deliberately
//     installed us — not a CI transitive resolution).
//   - stderr is a TTY (no banner in CI / Docker / pipes / log files).
//   - INIT_CWD points away from our own workspace (avoid printing during
//     monorepo dev `pnpm install`).
//
// Stays in pure ESM with no third-party imports so it runs without any
// dependency resolution — the postinstall script must work on a fresh
// install where node_modules may still be settling.
//
// Failure mode: any error here is swallowed. A banner crash must not break
// the install.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  // Bail in non-interactive environments. The npm install completion message
  // is already noise enough in CI logs.
  if (!process.stderr.isTTY) process.exit(0);

  // Bail when running inside the source repo's own install pass —
  // INIT_CWD is set by npm/pnpm to the directory the user ran the command
  // from. If that's our own monorepo, the maintainer is dogfooding, not
  // experiencing the install for the first time.
  const initCwd = process.env.INIT_CWD ?? process.cwd();
  const pkgDir = `${dirname(fileURLToPath(import.meta.url))}/..`;
  if (resolve(initCwd) === resolve(pkgDir, '..', '..')) process.exit(0);

  const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'));
  const version = pkg.version ?? 'dev';

  const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
  };

  const lines = [
    '',
    `${c.green}✓${c.reset} ${c.bold}Ethos${c.reset} ${c.dim}v${version}${c.reset} installed`,
    '',
    `${c.bold}Next steps${c.reset}`,
    `  ${c.cyan}ethos setup${c.reset}      ${c.dim}configure provider + first personality${c.reset}`,
    `  ${c.cyan}ethos chat${c.reset}       ${c.dim}start an interactive session${c.reset}`,
    `  ${c.cyan}ethos --help${c.reset}     ${c.dim}see all commands${c.reset}`,
    '',
    `${c.dim}Docs:${c.reset} ${c.cyan}https://ethosagent.ai${c.reset}`,
    `${c.dim}For a leaner install (no platform adapters):${c.reset}`,
    `  ${c.cyan}npm i -g @ethosagent/cli --omit=optional${c.reset}`,
    '',
  ];

  for (const line of lines) process.stderr.write(`${line}\n`);
} catch {
  // Best-effort. Never break the install.
}
