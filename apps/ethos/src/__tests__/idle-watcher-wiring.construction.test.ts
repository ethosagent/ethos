import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readGatewaySources } from '../commands/__tests__/gateway-sources';
import { readServeSources, serveFileWith } from '../commands/__tests__/serve-sources';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('idle watcher construction on the production boot path', () => {
  const commands: Array<{ file: string; builder: string; teardown: string }> = [
    {
      file: join(REPO_ROOT, 'apps', 'ethos', 'src', 'commands', 'gateway.ts'),
      builder: 'buildGatewayBusySources(',
      teardown: 'idleWatcher?.stop();',
    },
    {
      file: join(REPO_ROOT, 'apps', 'ethos', 'src', 'commands', 'serve.ts'),
      builder: 'buildServeBusySources(',
      teardown: 'idleWatcher?.stop();',
    },
  ];

  for (const command of commands) {
    describe(command.file.split('/').slice(-1)[0] ?? command.file, () => {
      let source: string;
      let whole: string;

      beforeEach(async () => {
        const isServe = command.file.endsWith('/serve.ts');
        // Ordering anchors must all sit in one module; counts span every module.
        source = isServe
          ? serveFileWith(
              'if (config.idleWatcher?.enabled === true) {',
              'new IdleWatcherManager(',
              'idleWatcher.start();',
              "process.on('SIGTERM'",
              command.teardown,
              command.builder,
            )
          : await readFile(command.file, 'utf-8');
        whole = isServe ? readServeSources() : readGatewaySources();
      });

      it('constructs the manager exactly once, from its own busy sources', () => {
        expect(whole.split('new IdleWatcherManager(').length - 1).toBe(1);
        expect(source).toContain(command.builder);
      });

      it('gates construction on the explicit opt-in (arming gate 1)', () => {
        const guard = source.indexOf('if (config.idleWatcher?.enabled === true) {');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(source.indexOf('new IdleWatcherManager('));
      });

      it('starts it — the whole point of wiring it', () => {
        expect(source).toContain('idleWatcher.start();');
      });

      it('stops it on the existing shutdown path, so SIGTERM leaves no interval', () => {
        expect(source).toContain(command.teardown);
        expect(source.indexOf(command.teardown)).toBeLessThan(
          source.indexOf('new IdleWatcherManager('),
        );
      });

      it('constructs it after the signal handlers — nothing else is wired later', () => {
        expect(source.indexOf("process.on('SIGTERM'")).toBeLessThan(
          source.indexOf('new IdleWatcherManager('),
        );
      });
    });
  }
});
