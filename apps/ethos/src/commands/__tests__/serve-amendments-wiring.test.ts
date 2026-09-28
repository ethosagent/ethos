import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// plan personality-memory-boundary-and-self-amendment G2 (D30) — every
// in-process web-API host hands `createWebApi` the loop's self-amendment
// service, so `amendments.list | get` read the same store the CLI decides in.
// A host that drops it answers `NOT_CONFIGURED` on the Learning page and the
// badge stops counting pending requests. The hosts are long-running
// composition roots, so this is asserted against source, like
// serve-goals-wiring.test.ts. The web holds only the reads (`AmendmentReader`);
// the service's own behaviour is pinned in apps/web-api/src/__tests__/services/
// amendments.service.test.ts.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8');

describe('createWebApi hosts — amendments injection', () => {
  it('ethos serve: both createAgentLoop branches and the team branch assign it', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src.match(/amendments = result\.amendments;/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/amendments: teamAmendments,/);
    expect(src).toMatch(/amendments = teamAmendments;/);
    const wiring = await read('apps/ethos/src/wiring.ts');
    expect(wiring).toMatch(
      /amendments: import\('@ethosagent\/wiring'\)\.CreateAgentLoopResult\['amendments'\];/,
    );
  });

  it('buildServeWebApi forwards it to createWebApi; ethos boot passes the shared loop’s', async () => {
    const serve = await read('apps/ethos/src/commands/serve.ts');
    expect(serve).toMatch(/Self-amendments, read-only \(D30\)[^\n]*\n\s+amendments,\n/);
    const boot = await read('apps/ethos/src/commands/boot.ts');
    expect(boot).toContain('amendments: shared.amendments,');
  });

  it('onboarding serve installs it when the booted loop is bound', async () => {
    const boot = await read('apps/ethos/src/lib/onboarding-boot.ts');
    expect(boot).toContain('...(booted.amendments ? { amendments: booted.amendments } : {}),');
    const web = await read('apps/web-api/src/index.ts');
    expect(web).toContain('if (extras.amendments) bound.amendments = extras.amendments;');
    expect(web).toContain('new AmendmentsService(() => bound.amendments ?? opts.amendments)');
  });

  it('the desktop app — the third host — passes it too', async () => {
    const desktop = await read('apps/desktop/src/main/serve.ts');
    expect(desktop).toMatch(/\n\s+amendments,\n\s+approverDecision,/);
    expect(desktop).toMatch(/apply stays in the CLI\.\n\s+amendments,\n/);
  });
});
