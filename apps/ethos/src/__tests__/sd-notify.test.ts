import { createSocket, type Socket } from 'node:dgram';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifyReady } from '../sd-notify';

let prevNotifySocket: string | undefined;

beforeEach(() => {
  prevNotifySocket = process.env.NOTIFY_SOCKET;
  delete process.env.NOTIFY_SOCKET;
});

afterEach(() => {
  if (prevNotifySocket === undefined) delete process.env.NOTIFY_SOCKET;
  else process.env.NOTIFY_SOCKET = prevNotifySocket;
});

describe('sd-notify', () => {
  it('does nothing when NOTIFY_SOCKET is unset', () => {
    expect(() => notifyReady()).not.toThrow();
  });

  it('sends READY=1 to a unix_dgram socket', async () => {
    let server: Socket;
    const socketPath = join(tmpdir(), `ethos-sd-notify-test-${process.pid}-${Date.now()}.sock`);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: unix_dgram not in TS types
      server = (createSocket as any)('unix_dgram') as Socket;
    } catch {
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        // biome-ignore lint/suspicious/noExplicitAny: unix_dgram bind overload not in TS types
        (server.bind as any)(socketPath, () => resolve());
        server.once('error', reject);
      });

      const received = new Promise<string>((resolve) => {
        server.once('message', (msg: Buffer) => resolve(msg.toString()));
      });

      process.env.NOTIFY_SOCKET = socketPath;
      notifyReady();

      const msg = await received;
      expect(msg).toBe('READY=1');
    } finally {
      server.close();
      try {
        rmSync(socketPath, { force: true });
      } catch {
        // cleanup best-effort
      }
    }
  });

  it('does not throw when NOTIFY_SOCKET points to a nonexistent path', () => {
    process.env.NOTIFY_SOCKET = '/tmp/ethos-sd-notify-nonexistent.sock';
    expect(() => notifyReady()).not.toThrow();
  });
});
