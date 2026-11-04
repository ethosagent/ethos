// ---------------------------------------------------------------------------
// Ollama install plan (keyless-first-run §3.4, D9–D11)
//
// DATA ONLY. This module computes what the install offer would run; it never
// spawns anything. Commands are string CONSTANTS with no interpolation. The
// consent and spawn live in apps/ethos/src/lib/ollama-install.ts.
//
// No license/agreement-accepting flag (`--accept-package-agreements`,
// `--accept-source-agreements`, `-y`) appears in any command or argv: pinned by
// apps/ethos/src/__tests__/ollama-install.test.ts ("no accept-agreements flag
// in any argv") and packages/wiring/src/__tests__/ollama-install-plan.test.ts.
// ---------------------------------------------------------------------------

export type OllamaInstallOs = 'linux' | 'darwin' | 'win32' | 'other';

export interface OllamaInstallPlan {
  os: OllamaInstallOs;
  /** The exact command string shown to the user, or null when there is none. */
  command: string | null;
  /** argv for `spawn(argv[0], argv.slice(1))`, or null when there is no command. */
  argv: readonly string[] | null;
  /** Shown before consent. */
  notes: string;
  /** Manual download page, for platforms with no runnable command. */
  downloadUrl: string | null;
  /** False when running as root or when there is no command. Enforced by
   *  `ollamaInstallPlan` (ollama-install-plan.test.ts: "root is never runnable"). */
  runnable: boolean;
}

export const LINUX_INSTALL_CMD = 'curl -fsSL https://ollama.com/install.sh | sh';
export const MACOS_BREW_INSTALL_CMD = 'brew install ollama && brew services start ollama';
// Q5: the winget id `Ollama.Ollama` is UNVERIFIED (winget is not available on the
// dev machine; check with `winget search ollama` on Windows before release).
export const WINDOWS_INSTALL_CMD = 'winget install --id Ollama.Ollama -e';

export const MACOS_DOWNLOAD_URL = 'https://ollama.com/download/mac';
export const WINDOWS_DOWNLOAD_URL = 'https://ollama.com/download/windows';
export const GENERIC_DOWNLOAD_URL = 'https://ollama.com/download';

export function ollamaInstallPlan(
  platform: string,
  opts: { hasBrew: boolean; isRoot: boolean },
): OllamaInstallPlan {
  const make = (
    os: OllamaInstallOs,
    command: string | null,
    argv: readonly string[] | null,
    notes: string,
    downloadUrl: string | null,
  ): OllamaInstallPlan => ({
    os,
    command,
    argv,
    notes,
    downloadUrl,
    runnable: command !== null && !opts.isRoot,
  });

  switch (platform) {
    case 'linux':
      return make(
        'linux',
        LINUX_INSTALL_CMD,
        ['sh', '-c', LINUX_INSTALL_CMD],
        "Ollama's script installs to /usr/local and sets up a system service. It will ask for your sudo password.",
        null,
      );
    case 'darwin':
      if (opts.hasBrew) {
        return make(
          'darwin',
          MACOS_BREW_INSTALL_CMD,
          ['sh', '-c', MACOS_BREW_INSTALL_CMD],
          'Installs with Homebrew and starts Ollama as a background service.',
          null,
        );
      }
      return make(
        'darwin',
        null,
        null,
        'Download and open Ollama, then come back. Ethos will keep checking.',
        MACOS_DOWNLOAD_URL,
      );
    case 'win32':
      return make(
        'win32',
        WINDOWS_INSTALL_CMD,
        ['winget', 'install', '--id', 'Ollama.Ollama', '-e'],
        "winget will show Ollama's license and ask you to accept it.",
        WINDOWS_DOWNLOAD_URL,
      );
    default:
      return make(
        'other',
        null,
        null,
        'Download and install Ollama, then come back. Ethos will keep checking.',
        GENERIC_DOWNLOAD_URL,
      );
  }
}
