import { execSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, timeout = 30_000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout }).trim();
}

const IMAGE = 'ethos-smoke-test';
const CONTAINER = 'ethos-smoke';

describe.skipIf(!process.env.CI || !dockerAvailable())('Docker smoke test', () => {
  afterAll(() => {
    try {
      run(`docker rm -f ${CONTAINER}`);
    } catch {}
    try {
      run(`docker rmi ${IMAGE}`);
    } catch {}
  });

  it('builds the image', () => {
    run(`docker build -t ${IMAGE} apps/ethos/`, 120_000);
    const images = run(`docker images -q ${IMAGE}`);
    expect(images).toBeTruthy();
  });

  it('starts in ui mode and passes healthcheck', async () => {
    run(`docker run -d --name ${CONTAINER} -e ETHOS_MODE=ui -p 13579:3000 ${IMAGE}`);

    // Poll healthcheck — up to 30 seconds
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch('http://localhost:13579/healthz');
        if (resp.ok) {
          const body = (await resp.json()) as { status: string };
          if (body.status === 'ok') {
            healthy = true;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(healthy).toBe(true);
  }, 60_000);

  it('shuts down cleanly on SIGTERM', () => {
    run(`docker stop ${CONTAINER}`, 15_000);
    const exitCode = run(`docker inspect --format='{{.State.ExitCode}}' ${CONTAINER}`);
    // Accept 0 (clean) or 143 (SIGTERM — common for Node processes)
    expect(['0', '143']).toContain(exitCode);
  });
});
