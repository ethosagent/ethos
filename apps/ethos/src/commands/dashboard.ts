import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { EthosConfig } from '../config';
import { runServe } from './serve';

// `ethos dashboard` — discoverability alias for `ethos serve --web-experimental`.
//
// Rationale: operators don't intuit that `--web-experimental` is the verb that
// boots the web mission-control UI. The dashboard verb makes the surface
// discoverable from `ethos --help` without changing the underlying boot path.
// All flags are forwarded; `--no-open` suppresses the auto-launch of the
// default browser (useful in headless deployments / CI).

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
};

export async function runDashboard(args: string[], config: EthosConfig): Promise<void> {
  const shouldOpen = !args.includes('--no-open');
  const filtered = args.filter((a) => a !== '--no-open');

  // Always boot the web surface. If --web-experimental is already in args
  // we don't double it; if not we inject it. serve.ts treats `hasFlag`
  // membership, not count.
  const forwarded = filtered.includes('--web-experimental')
    ? filtered
    : ['--web-experimental', ...filtered];

  const webPort = parsePort(filtered, ['--web-port'], 3000);

  console.log(
    `${c.cyan}${c.bold}ethos dashboard${c.reset} ${c.dim}— booting via 'ethos serve --web-experimental'${c.reset}`,
  );

  if (shouldOpen) {
    // Open the browser shortly after serve binds the port. Three-second
    // delay is conservative — serve typically binds in < 1s, but the
    // first --web-dist build adds variable latency. The browser opens
    // to the auth-exchange URL the serve banner prints; if the
    // operator wants the static `/` instead they can pass --no-open.
    const opener = browserOpener();
    if (opener) {
      setTimeout(() => {
        spawn(opener.cmd, [...opener.args, `http://localhost:${webPort}/`], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }, 3000);
    } else {
      console.log(
        `${c.dim}(--no-open or unsupported platform — open http://localhost:${webPort}/ manually)${c.reset}`,
      );
    }
  }

  await runServe(forwarded, config);
}

function browserOpener(): { cmd: string; args: string[] } | null {
  switch (platform()) {
    case 'darwin':
      return { cmd: 'open', args: [] };
    case 'linux':
      return { cmd: 'xdg-open', args: [] };
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', ''] };
    default:
      return null;
  }
}

function parsePort(argv: string[], names: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (names.includes(a)) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    for (const n of names) {
      if (a.startsWith(`${n}=`)) {
        const v = Number(a.slice(n.length + 1));
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  }
  return fallback;
}
