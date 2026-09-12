import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutboxStore } from '@ethosagent/outbox';
import { FsStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { OutboxService } from '../../services/outbox.service';

// O-T9, the layer boundary — web-api NEVER calls a channel adapter.
//
// A decision is not a delivery. `outbox.approve` writes one row and returns;
// the gateway process, which is the only one that holds adapters, polls the
// same file, claims the row and calls `sendTracked` (O-T5/O-T6). If this ever
// stops being true, an approval on a settings page starts posting to real
// people from a process with no botKey resolution, no delivery ledger and no
// dedup — the three things that make a publication safe to send once.
//
// Two enforcers, because neither alone is enough: the source scan catches an
// import, and the shape assertion catches an adapter handed in at construction.

const SERVICE = join(import.meta.dirname, '..', '..', 'services', 'outbox.service.ts');
const RPC = join(import.meta.dirname, '..', '..', 'rpc', 'outbox.ts');

/** Anything that can put bytes on a platform, or reach something that can. */
const FORBIDDEN_IMPORTS = [
  '@ethosagent/gateway',
  '@ethosagent/platform-telegram',
  '@ethosagent/platform-slack',
  '@ethosagent/platform-discord',
  '@ethosagent/platform-whatsapp',
  '@ethosagent/platform-email',
  '@ethosagent/platform-voice',
  '@ethosagent/delivery-ledger',
];

describe('outbox web surface never reaches an adapter', () => {
  for (const file of [SERVICE, RPC]) {
    it(`${file.split('/').slice(-2).join('/')} imports nothing that can send`, () => {
      const src = readFileSync(file, 'utf-8');
      const offenders = FORBIDDEN_IMPORTS.filter((pkg) =>
        new RegExp(`from\\s+['"]${pkg.replace(/\//g, '\\/')}['"]`).test(src),
      );
      expect(offenders).toEqual([]);
    });
  }

  it('the service exposes no send path and holds no adapter', () => {
    const service = new OutboxService({
      dataDir: '/nonexistent',
      storage: new FsStorage(),
      openStore: () => ({}) as unknown as OutboxStore,
      teamMembers: async () => [],
    });

    // The public surface: reads and the five human decisions. No `send`,
    // `deliver`, `claim` or `dispatch` — those words belong to the gateway.
    const methods = Object.getOwnPropertyNames(OutboxService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual([
      'approve',
      'close',
      'decide',
      'edit',
      'get',
      'list',
      'open',
      'personalityFilter',
      'reject',
      'retry',
      'revoke',
      'toView',
    ]);

    // And nothing adapter-shaped was injected: every value the instance holds is
    // a store path, a Storage, or one of the declared seams.
    const injected = Object.values(service as unknown as Record<string, unknown>);
    for (const value of injected) {
      expect(hasSend(value)).toBe(false);
    }
  });
});

/** `Adapter.send` is the one method every channel adapter has. */
function hasSend(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.send === 'function') return true;
  return Object.values(record).some(
    (inner) =>
      typeof inner === 'object' &&
      inner !== null &&
      typeof (inner as Record<string, unknown>).send === 'function',
  );
}
