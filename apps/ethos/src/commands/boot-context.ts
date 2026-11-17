// Context types for `runBoot`'s phase functions (./boot.ts). Type-only: each
// field is a `runBoot` local, handed to the phase by reference.

import type { EthosConfig, WebhookHookConfig } from '@ethosagent/config';
import type { ConsoleLogger } from '@ethosagent/logger';
import type { PlatformAdapter } from '@ethosagent/types';
import type { WebBindTarget } from '../config-reload';
import type { createOutboxRuntime } from '../lib/outbox-wiring';
import type { getSecretsResolver, getStorage } from '../wiring';
import type {
  buildGateway,
  buildGatewayAdapters,
  buildGatewayBots,
  buildPlatformWebhookMounts,
  GatewayBotWiring,
} from './gateway';
import type { ListenResult } from './serve-listen';

export type BootGateway = ReturnType<typeof buildGateway>;
export type BootBot = Awaited<ReturnType<typeof buildGatewayBots>>['bots'][number];
export type WebServer = ListenResult['server'];

/** Each field is the `runBoot` local of the same name. */
export interface BootReloadContext {
  args: string[];
  cfg: EthosConfig;
  dir: string;
  storage: ReturnType<typeof getStorage>;
  secrets: Awaited<ReturnType<typeof getSecretsResolver>>;
  logger: ConsoleLogger;
  scheduler: Parameters<typeof buildGatewayBots>[1];
  watcherManager: Parameters<typeof buildGatewayBots>[2];
  outbox: ReturnType<typeof createOutboxRuntime>;
  attachmentCache: Parameters<typeof buildGatewayAdapters>[1];
  gateway: BootGateway;
  gatewayRef: BootGateway | null;
  botWiring: Map<string, () => Promise<void>>;
  registerBotLive: (
    bot: BootBot,
    wiring: GatewayBotWiring,
    adaptersSlice: PlatformAdapter[],
  ) => Promise<() => Promise<void>>;
  releaseBotLoops: (wiring: GatewayBotWiring, id: string) => Promise<void>;
  liveWebhooks: Record<string, WebhookHookConfig>;
  ensureWebhookServer: () => void;
  releaseWebhookServerIfIdle: () => void;
  platformWebhookMounts: ReturnType<typeof buildPlatformWebhookMounts>;
  ensurePlatformWebhookServer: () => void;
  releasePlatformWebhookServerIfIdle: () => void;
  /** Live accessors over `runBoot`'s `webServer` / `webRequested`. */
  web: { server: WebServer; requested: WebBindTarget };
  listenWeb: (bind: WebBindTarget) => Promise<ListenResult>;
  attachWebSockets: (target: WebServer) => void;
  announceWebBind: (host: string, boundPort: number) => string | null;
  reason: (err: unknown) => string;
}
