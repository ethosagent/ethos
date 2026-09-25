// The bundled skills must not tell the agent to run a shell command the
// terminal guard refuses. Two hardline families landed in lane A of plan
// openclaw-2026.9.6-gaps and each broke bundled skills that predated them:
//   - S16: any command naming the Ethos state dir (`stateDirReference`), which
//     is why scratch/work dirs moved to the workspace's `./.ethos-work/`;
//   - D1(b): inline-eval wrappers (`node -e`, `sh -c`, `$(…)`, …).
// This scans every fenced ```bash / ```sh / ```shell / ```zsh block in
// skills/**/SKILL.md, one command per line (backslash continuations joined),
// through `checkCommand` — the same check `createTerminalGuardHook` applies.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../guard';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SKILLS_ROOT = join(REPO, 'skills');

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : skillFiles(path);
    return e.name === 'SKILL.md' ? [path] : [];
  });
}

/** Shell commands from the fenced shell blocks of one markdown file. */
function shellCommands(markdown: string): string[] {
  const commands: string[] = [];
  const fence = /^```(bash|sh|shell|zsh)\s*\n([\s\S]*?)^```/gm;
  for (const match of markdown.matchAll(fence)) {
    const body = (match[2] ?? '').replace(/\\\n\s*/g, ' ');
    for (const line of body.split('\n')) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith('#')) commands.push(cmd);
    }
  }
  return commands;
}

/**
 * Blocks a skill tells the USER to run in their own terminal, with the skill
 * text saying so. Each entry is reviewed: adding one means a human, not the
 * agent, runs that command.
 */
const OPERATOR_RUN: Record<string, ReadonlyArray<string>> = {
  // Path C — SSH key setup touches ~/.ssh (always-deny floor) and uses eval.
  'skills/github/github-auth/SKILL.md': [
    'ssh-keygen -t ed25519',
    'eval "$(ssh-agent -s)"',
    'ssh-add --apple-use-keychain ~/.ssh/id_ed25519_github',
    'cat ~/.ssh/id_ed25519_github.pub',
  ],
};

const operatorRun = (file: string, cmd: string): boolean =>
  (OPERATOR_RUN[relative(REPO, file)] ?? []).some((prefix) => cmd.startsWith(prefix));

describe('bundled skills — shell blocks pass the terminal guard', () => {
  const files = skillFiles(SKILLS_ROOT);

  it('finds the bundled skills', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no shell block names the Ethos state dir (~/.ethos, $HOME/.ethos or the braced form)', () => {
    const offenders = files.flatMap((file) =>
      shellCommands(readFileSync(file, 'utf8'))
        .filter((cmd) => /(?:~|\$HOME|\$\{HOME\})\/\.ethos(?![\w-])/.test(cmd))
        .map((cmd) => `${relative(REPO, file)}: ${cmd}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no shell block is refused by checkCommand', () => {
    const offenders = files.flatMap((file) =>
      shellCommands(readFileSync(file, 'utf8')).flatMap((cmd) => {
        if (operatorRun(file, cmd)) return [];
        const result = checkCommand(cmd);
        return result.dangerous ? [`${relative(REPO, file)}: ${cmd} — ${result.reason}`] : [];
      }),
    );
    expect(offenders).toEqual([]);
  });
});
