// Raw `node:fs` carve-out (Law 7) — see apps/ethos/src/__tests__/no-raw-fs.test.ts
// and the allowed-exception list in CLAUDE.md. Creating a run's workspace is a
// `git worktree add`: the git binary writes a whole tree, which no Storage
// method can express, and the surrounding mkdir/exists checks are that same
// operation's bookkeeping. Same category as the SQLite stores' mkdirSync of a
// database's parent directory. Identical rationale to (and copied from, not
// imported from) `execution-pi/src/worktree.ts` — D-ACP1: no shared file
// between the two packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every host path one ACP-agent run owns. Both sit under `${ETHOS_HOME}/worktrees/`. */
export interface AcpWorkspacePaths {
  /** `${ETHOS_HOME}/worktrees` — the root a personality's `fs_reach` must cover. */
  root: string;
  /** The run's git worktree. The agent's cwd, and the only writable code path it sees. */
  workspace: string;
  /**
   * The agent's own session/scratch storage, a SIBLING of the worktree rather
   * than a directory inside it: a session dir inside the worktree would show
   * up in the diff a human reviews, and the whole point of the worktree is
   * that its diff IS the run's output. Sibling placement keeps ONE `fs_reach`
   * prefix covering both — same reasoning as Pi's `sessionDir`.
   */
  sessionDir: string;
}

/**
 * D24 — one worktree per run at `${ETHOS_HOME}/worktrees/<jobId>`, generalized
 * off `jobId` exactly the way `execution-pi/src/worktree.ts`'s
 * `piWorkspacePaths` already is. Job ids are unique across every runner (the
 * id space is the shared `JobStore`'s, not per-runner), so a Pi job and an ACP
 * job never collide under the same `worktrees/` root.
 */
export function acpWorkspacePaths(ethosHome: string, jobId: string): AcpWorkspacePaths {
  const root = join(ethosHome, 'worktrees');
  return { root, workspace: join(root, jobId), sessionDir: join(root, `${jobId}.session`) };
}

/** True when `path` equals `prefix` or is nested under it (path-segment safe). */
function isUnder(path: string, prefix: string): boolean {
  const p = resolve(prefix);
  return path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export class WorkspaceOutOfReachError extends Error {
  readonly code = 'WORKSPACE_OUT_OF_REACH';
  constructor(personalityId: string, workspace: string) {
    super(
      `personality '${personalityId}' cannot run this job: its fs_reach does not cover ${workspace}. ` +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an fs_reach substitution token, not a JS template.
        'Add "${ETHOS_HOME}/worktrees/" to the personality\'s fs_reach.write.',
    );
    this.name = 'WorkspaceOutOfReachError';
  }
}

/**
 * D24's other half: the worktree must be INSIDE the personality's declared
 * reach, not merely somewhere convenient. Refuses loudly and names the entry
 * to add — same containment claim `execution-pi`'s worktree module makes,
 * proven here for a second runner kind rather than assumed to transfer.
 */
export function assertWorkspaceInReach(
  personalityId: string,
  workspace: string,
  writeReach: readonly string[],
): void {
  const target = resolve(workspace);
  if (!writeReach.some((entry) => isUnder(target, entry))) {
    throw new WorkspaceOutOfReachError(personalityId, workspace);
  }
}

export interface PreparedWorkspace extends AcpWorkspacePaths {
  /** The repository the worktree branched from, when the source workdir was one. */
  sourceRepo?: string;
}

export interface CommandOptions {
  /** Merged OVER the inherited environment. */
  env?: Record<string, string>;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  options?: CommandOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Variables that would redirect git to a repository other than the one `-C` names. */
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

/** Default runner — a plain spawn with output captured. Injected for tests. */
export const spawnCapture: CommandRunner = (cmd, args, options) =>
  new Promise((resolveOut) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options?.env) {
      for (const name of GIT_LOCATION_VARS) delete env[name];
      Object.assign(env, options.env);
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => resolveOut({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolveOut({ code: code ?? -1, stdout, stderr }));
  });

/**
 * Environment of every git call preparation makes: no system or user config, no
 * credential prompt. It is merged over the inherited environment, so PATH and
 * the like still resolve `git`.
 */
const ISOLATED_GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Prefix for commands that read the SOURCE repository's own config: its hooks
 * and fsmonitor program are named there, and `-c` outranks the repo's config
 * file. `worktree add` can run `post-checkout`; any status-like command can run
 * `core.fsmonitor`.
 */
const SOURCE_GIT_OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/** Run git; throw with its stderr (else `<subcommand> exit <code>`) when it fails. */
async function gitOrThrow(
  run: CommandRunner,
  args: string[],
  options?: CommandOptions,
): Promise<void> {
  const result = await run('git', args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `${args[0]} exit ${result.code}`);
  }
}

/**
 * Fill `workspace` with `commit`'s tree without consulting the source repository's
 * configuration or attributes drivers.
 *
 * A throwaway bare git dir is the only configuration git sees: it is created
 * from an empty template, so it defines no `filter.<name>.*` (an undefined
 * driver is skipped, so `smudge`/`clean`/`process` programs never run), no
 * hooks and no `core.fsmonitor`. Objects come from the source repository
 * through `objects/info/alternates`, which is a read of object files only. The
 * index is the worktree's own, so the finished workspace is registered
 * consistently with `HEAD`.
 */
async function populateWorkspace(
  paths: AcpWorkspacePaths,
  commit: string,
  objectFormat: string,
  objectsDir: string,
  run: CommandRunner,
): Promise<void> {
  const scratch = mkdtempSync(join(paths.root, '.populate-'));
  try {
    const template = join(scratch, 'template');
    const gitDir = join(scratch, 'git');
    mkdirSync(template);
    await gitOrThrow(run, ['init', '--bare', '-q', `--object-format=${objectFormat}`, gitDir], {
      env: { ...ISOLATED_GIT_ENV, GIT_TEMPLATE_DIR: template },
    });
    writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${objectsDir}\n`);

    const link = readFileSync(join(paths.workspace, '.git'), 'utf-8').trim();
    if (!link.startsWith('gitdir:')) throw new Error(`unexpected .git file: ${link}`);
    const env = {
      ...ISOLATED_GIT_ENV,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: paths.workspace,
      GIT_INDEX_FILE: join(link.slice('gitdir:'.length).trim(), 'index'),
    };
    await gitOrThrow(run, ['read-tree', commit], { env });
    await gitOrThrow(run, ['checkout-index', '-a', '-f'], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Create the run's workspace before the host is spawned.
 *
 * When the source workdir is a git repository the workspace is a real detached
 * worktree of it, so the run's diff is reviewable against the branch it came
 * from and `git worktree remove` is the undo. When it is not a repository the
 * workspace is a fresh empty directory: isolation is the requirement (sharing
 * the parent workdir is forbidden), and a repository is not.
 *
 * GUARANTEE: preparation runs no program named by the source repository's
 * configuration or attributes. The worktree is registered with
 * `--no-checkout` (every git call carries `core.hooksPath=/dev/null` and
 * `core.fsmonitor=false` and ignores system/user config), then populated by
 * `populateWorkspace` under a throwaway git dir that defines no filter drivers.
 * Pinned by 'a fixture repo configured to create a marker file on checkout
 * leaves no marker after prepareWorkspace' in `__tests__/worktree.test.ts`.
 * The tree matches a plain checkout for a repository whose config sets no
 * eol/filter options ('a normal repo's working tree is byte-identical to a
 * plain checkout').
 *
 * LIMITS: (1) Git LFS (and any other `filter.*.required` clean/smudge driver)
 * content arrives as the pointer/clean blob, because the driver is never run.
 * (2) A source repository with no commits is refused, there being nothing to
 * check out. (3) The guarantee covers preparation only: later `git` run in the
 * workspace reads the source repository's config through the worktree link.
 *
 * Idempotent — an existing workspace is reused, which is what makes a Resume of
 * the same job id land on the same tree rather than a second copy.
 *
 * KNOWN LIMIT (Phase 2): only the worktree is mounted into the container, so
 * in-container `git` cannot follow the worktree's `.git` FILE back to the parent
 * repository's object store. The agent can read and write files; it cannot commit.
 * Mounting the parent `.git` would hand the run the whole repository and void
 * the `worktree only` claim, so the limit stands until a phase needs commits.
 */
export async function prepareWorkspace(
  paths: AcpWorkspacePaths,
  sourceWorkdir: string,
  run: CommandRunner = spawnCapture,
): Promise<PreparedWorkspace> {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });

  if (existsSync(paths.workspace)) return paths;

  const top = await run(
    'git',
    ['-C', sourceWorkdir, ...SOURCE_GIT_OVERRIDES, 'rev-parse', '--show-toplevel'],
    { env: ISOLATED_GIT_ENV },
  );
  if (top.code !== 0) {
    mkdirSync(paths.workspace, { recursive: true });
    return paths;
  }
  const sourceRepo = top.stdout.trim();
  const failure = (detail: string): Error =>
    new Error(`git worktree add failed for ${paths.workspace} (from ${sourceRepo}): ${detail}`);

  const facts = await run(
    'git',
    [
      '-C',
      sourceRepo,
      ...SOURCE_GIT_OVERRIDES,
      'rev-parse',
      'HEAD',
      '--show-object-format',
      '--git-common-dir',
    ],
    { env: ISOLATED_GIT_ENV },
  );
  const [commit, objectFormat, commonDir] = facts.stdout.trim().split('\n');
  if (
    facts.code !== 0 ||
    !commit ||
    !/^[0-9a-f]{40,64}$/.test(commit) ||
    !objectFormat ||
    !commonDir
  ) {
    throw failure(facts.stderr.trim() || 'the source repository has no commits to check out');
  }

  const added = await run(
    'git',
    [
      '-C',
      sourceRepo,
      ...SOURCE_GIT_OVERRIDES,
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      paths.workspace,
      commit,
    ],
    { env: ISOLATED_GIT_ENV },
  );
  if (added.code !== 0) throw failure(added.stderr.trim() || `exit ${added.code}`);

  try {
    await populateWorkspace(
      paths,
      commit,
      objectFormat,
      join(resolve(sourceRepo, commonDir), 'objects'),
      run,
    );
  } catch (err) {
    // Leave nothing behind: an existing directory is reused as-is on Resume, so a
    // half-populated worktree would be adopted as the run's tree. Remove ONLY this
    // run's worktree (admin entry and directory). Never `git worktree prune`: it is
    // repo-wide and would delete the admin entries of the user's own worktrees whose
    // directories are merely missing right now (a moved or unmounted checkout).
    await run(
      'git',
      [
        '-C',
        sourceRepo,
        ...SOURCE_GIT_OVERRIDES,
        'worktree',
        'remove',
        '--force',
        '--force',
        paths.workspace,
      ],
      { env: ISOLATED_GIT_ENV },
    );
    rmSync(paths.workspace, { recursive: true, force: true });
    throw failure(
      `populating the worktree failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { ...paths, sourceRepo };
}
