// WIRING lane, source-text checks (runGatewayStart, runBoot, §5) — split from the original gateway-platform-webhook-wiring.test.ts;
// see plan/phases/telegram-slack-webhook-mode.md. Shared stubs: ./gateway-platform-webhook-wiring.fixtures

import { describe, expect, it } from 'vitest';
import { bootFileWith, readBootSources } from '../commands/__tests__/boot-sources';
import { readGatewaySources } from '../commands/__tests__/gateway-sources';
import { read } from './gateway-platform-webhook-wiring.fixtures';

// ---------------------------------------------------------------------------
// Inside `runGatewayStart` — source-text, per the file header's reasoning.
// ---------------------------------------------------------------------------

describe('runGatewayStart wiring (source)', () => {
  it('builds the mounts AFTER every adapter has been started', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    const startedAt = src.indexOf('await startAdaptersIsolated(adapters, {');
    const mountedAt = src.indexOf('buildPlatformWebhookMounts(config, adapters');
    expect(startedAt).toBeGreaterThan(-1);
    expect(mountedAt).toBeGreaterThan(-1);
    // `TelegramAdapter.webhook` is undefined until start() — the reverse order
    // mounts nothing and 404s every delivery.
    expect(mountedAt).toBeGreaterThan(startedAt);
  });

  it('starts the server only when at least one bot or app needs it', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    // The gate lives in `ensurePlatformWebhookServer`, as in boot.ts, so an
    // adapter that starts on a background retry (V-CC-4) can bind the listener
    // for the first route it mounts. Still: no mounted route, no bound port.
    expect(src).toContain(
      'if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;',
    );
  });

  it('resolves port 3006 and the shared serve host, matching the sibling servers', async () => {
    const src = readGatewaySources();
    expect(src).toContain(
      'const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;',
    );
    expect(src).toContain(
      "const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';",
    );
    // 3004 is ETHOS_RUNALL_HEALTH_PORT and run-all spawns this process.
    expect(src).not.toContain('ETHOS_PLATFORM_WEBHOOK_PORT) || 3004');
  });

  it('closes the server alongside the other webhook servers on shutdown', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).toMatch(
      /webhookServer\?\.close\(\);\s*\n\s*sipWebhookServer\?\.close\(\);\s*\n\s*platformWebhookServer\?\.close\(\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// `ethos boot` — the merged single-process profile. Same source-text idiom and
// the same four facts as `runGatewayStart` above, because the failure this
// guards against is SILENT: `boot.ts` shares `buildGatewayAdapters` with
// `runGatewayStart`, so a bot with `use_webhook` boots identically under both
// and calls `setWebhook()` against Telegram either way. Without a listener,
// that registers a public URL against a port nothing is bound to — every
// inbound message 404s and the process logs nothing to say why. A missing
// mount here is not a missing feature, it is a broken channel that looks fine.
// ---------------------------------------------------------------------------

describe('runBoot wiring — parity with runGatewayStart (source)', () => {
  it('builds the mounts AFTER every adapter has been started', async () => {
    const src = bootFileWith(
      'await startAdaptersIsolated(adapters, {',
      'buildPlatformWebhookMounts(cfg, gateway.listAdapters()',
    );
    const startedAt = src.indexOf('await startAdaptersIsolated(adapters, {');
    const mountedAt = src.indexOf('buildPlatformWebhookMounts(cfg, gateway.listAdapters()');
    expect(startedAt).toBeGreaterThan(-1);
    expect(mountedAt).toBeGreaterThan(-1);
    // Same ordering constraint as the gateway: `TelegramAdapter.webhook` is
    // undefined until start(), so the reverse order mounts nothing.
    expect(mountedAt).toBeGreaterThan(startedAt);
  });

  it('starts the server only when at least one bot or app needs it', async () => {
    const src = bootFileWith(
      'if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;',
    );
    // The gate moved inside `ensurePlatformWebhookServer` with Phase C — the
    // same listener is now bound on demand, either at boot or when a live
    // config edit mounts the first route — but the rule is unchanged: no
    // mounted route, no bound port.
    expect(src).toContain(
      'if (platformWebhookMounts.telegram.size === 0 && platformWebhookMounts.slack.size === 0) return;',
    );
  });

  it('resolves the same port and host as runGatewayStart, not a second convention', async () => {
    const boot = bootFileWith(
      'const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;',
      "const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';",
    );
    const gateway = await read('apps/ethos/src/commands/gateway.ts');
    const portLine =
      'const platformWebhookPort = Number(process.env.ETHOS_PLATFORM_WEBHOOK_PORT) || 3006;';
    const hostLine = "const platformWebhookHost = process.env.ETHOS_SERVE_HOST ?? '127.0.0.1';";
    // Asserted against BOTH files with the same literal: a deployment that
    // moves the port by env var must move it for both entry points at once.
    for (const src of [boot, gateway]) {
      expect(src).toContain(portLine);
      expect(src).toContain(hostLine);
    }
  });

  it('reserves the bound port against the web bind ladder', async () => {
    const src = bootFileWith(
      'platformWebhookPort]);',
      'const reservedPorts = new Set<number>(',
      'listenWithFallback(',
    );
    // boot.ts is the only entry point that walks a fallback ladder for the web
    // bind, so it is the only one that can collide with its own listener.
    // Reserved unconditionally since Phase C — see the matching assertion in
    // `boot-profile-command.test.ts` for why.
    expect(src).toContain('platformWebhookPort]);');
    const reservedAt = src.indexOf('const reservedPorts = new Set<number>(');
    const ladderAt = src.indexOf('listenWithFallback(');
    expect(reservedAt).toBeGreaterThan(-1);
    expect(ladderAt).toBeGreaterThan(reservedAt);
  });

  it('closes the server on shutdown, under its own guard', async () => {
    const src = bootFileWith("await guard('platform-webhook-server'");
    // `guard()` per teardown, so one failing close cannot strand the rest —
    // boot.ts's shutdown idiom, not gateway.ts's bare sequence.
    expect(src).toMatch(
      /await guard\('platform-webhook-server', \(\) => \{\s*\n\s*platformWebhookServer\?\.close\(\);\s*\n\s*\}\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// §5 — durable inbound dedup wiring. The store's own semantics (TTL, restart
// survival) are covered by `extensions/inbound-dedup` and
// `extensions/gateway/src/__tests__/inbound-dedup-durable.test.ts`; what is
// asserted here is only that something actually constructs it and hands it to
// the Gateway, which is the gap this lane closed.
// ---------------------------------------------------------------------------

describe('§5 durable inbound dedup wiring (source)', () => {
  for (const file of ['apps/ethos/src/commands/gateway.ts', 'apps/ethos/src/commands/boot.ts']) {
    it(`${file} constructs the store, passes it to buildGateway, and closes it`, async () => {
      const src = file.endsWith('/boot.ts') ? readBootSources() : await read(file);
      expect(src).toContain("import { SQLiteInboundDedupStore } from '@ethosagent/inbound-dedup';");
      expect(src).toMatch(/new SQLiteInboundDedupStore\(join\(.*'inbound-dedup\.db'\)\)/);
      expect(src).toMatch(/deliveryLedger,\n\s*inboundDedup,/);
      expect(src).toContain('inboundDedup.close();');
    });
  }

  it('is a required BuildGatewayOptions field, so no caller can forget it', async () => {
    expect(readGatewaySources()).toContain("inboundDedup: GatewayConfig['inboundDedup'];");
  });

  it('the gateway package declares the workspace edge it imports the type from', async () => {
    const pkg = JSON.parse(await read('extensions/gateway/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@ethosagent/inbound-dedup']).toBe('workspace:*');
  });
});
