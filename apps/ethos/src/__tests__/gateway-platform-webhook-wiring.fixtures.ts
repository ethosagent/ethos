// Shared fixtures for the gateway-platform-webhook-wiring.*.test.ts suites —
// stub adapters and a stub module loader, so no live grammy / @slack/bolt
// construction is needed (same harness as `gateway-build-adapters.test.ts`).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import type { AdapterModuleLoader } from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

interface CapturedAdapter extends PlatformAdapter {
  readonly capturedConfig: Record<string, unknown>;
}

export const capturedOf = (a: PlatformAdapter): Record<string, unknown> =>
  (a as CapturedAdapter).capturedConfig;

/**
 * Stub adapters that mimic the ONE lifecycle detail this wiring depends on:
 * `TelegramAdapter.webhook` is `undefined` until `start()` has built grammy's
 * callback, while `SlackAdapter.requestListener` / `.webhookRoute` are
 * available from construction. If `buildPlatformWebhookMounts` were ever
 * called before `adapter.start()`, the Telegram half would silently come back
 * empty — so the stubs reproduce that asymmetry rather than papering over it.
 */
function makeStub(name: string, cfg: Record<string, unknown>): CapturedAdapter {
  const botKey = cfg.botKey as string | undefined;
  const httpMode = (cfg.mode as { http?: boolean } | undefined)?.http === true;
  const segment = (cfg.webhookPath as string | undefined) ?? botKey;
  let webhook: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const adapter = {
    id: botKey ? `${name}:${botKey}` : name,
    displayName: name,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    capturedConfig: cfg,
    async start() {
      if (name === 'telegram' && cfg.useWebhook === true) {
        webhook = async () => {};
      }
    },
    async stop() {},
    async send() {
      return { ok: true };
    },
    onMessage(_h: (m: InboundMessage) => void) {},
    async health() {
      return { ok: true };
    },
    // Telegram: absent until start().
    get webhook() {
      return webhook;
    },
    // Slack: present from construction, in http mode only.
    requestListener: name === 'slack' && httpMode ? () => {} : undefined,
    webhookRoute: name === 'slack' && httpMode ? `/slack/events/${segment}` : undefined,
  };
  return adapter as unknown as CapturedAdapter;
}

/** Copy a stub onto `this`, getters included. */
function adopt(target: object, stub: CapturedAdapter): void {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(stub));
}

export function makeLoader(): AdapterModuleLoader {
  const MODULES: Record<string, unknown> = {
    // Property DESCRIPTORS, not `Object.assign` (the idiom in
    // `gateway-build-adapters.test.ts`): `Object.assign` INVOKES the `webhook`
    // getter and copies its value, freezing it at the pre-`start()`
    // `undefined` and making the lifecycle asymmetry untestable.
    '@ethosagent/platform-telegram': {
      TelegramAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          adopt(this, makeStub('telegram', cfg));
        }
      },
    },
    '@ethosagent/platform-slack': {
      SlackAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          adopt(this, makeStub('slack', cfg));
        }
      },
    },
  };
  return async <T>(modulePath: string): Promise<T | null> =>
    (MODULES[modulePath] ?? null) as T | null;
}

export const baseConfig: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk',
  personality: 'researcher',
};

export const startAll = (adapters: PlatformAdapter[]) =>
  Promise.all(adapters.map((a) => a.start()));

// ---------------------------------------------------------------------------
// §9 "Default-preserving test" — the most important one in this lane.
// ---------------------------------------------------------------------------
