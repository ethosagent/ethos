import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { runServe } from './serve';
// `ethos dashboard` — discoverability alias for `ethos serve`.
//
// Rationale: `ethos serve` always boots the web mission-control UI, but the
// dashboard verb makes the surface discoverable from `ethos --help` and
// auto-opens the browser. All flags are forwarded; `--no-open` suppresses
// the auto-launch of the default browser (useful in headless deployments / CI).
const c = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
};
export async function runDashboard(args, config) {
    const shouldOpen = !args.includes('--no-open');
    const filtered = args.filter((a) => a !== '--no-open');
    const forwarded = filtered;
    const webPort = parsePort(filtered, ['--web-port'], 3000);
    console.log(`${c.cyan}${c.bold}ethos dashboard${c.reset} ${c.dim}— booting via 'ethos serve'${c.reset}`);
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
        }
        else {
            console.log(`${c.dim}(--no-open or unsupported platform — open http://localhost:${webPort}/ manually)${c.reset}`);
        }
    }
    await runServe(forwarded, config);
}
function browserOpener() {
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
function parsePort(argv, names, fallback) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] ?? '';
        if (names.includes(a)) {
            const v = Number(argv[i + 1]);
            if (Number.isFinite(v) && v > 0)
                return v;
        }
        for (const n of names) {
            if (a.startsWith(`${n}=`)) {
                const v = Number(a.slice(n.length + 1));
                if (Number.isFinite(v) && v > 0)
                    return v;
            }
        }
    }
    return fallback;
}
