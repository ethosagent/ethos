// plan channel-prompts-ui L4 — RoomPolicyService over InMemoryStorage, a real
// ConfigRepository and a stubbed session store. Every threat-model row the plan
// assigns to this file ('caps', 'sanitise warning', 'refuses what boot would
// drop', 'conflict', 'config write fails after file write', 'recent rooms carry
// no titles', 'incognito excluded') is a case below.

import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { EthosError, Session } from '@ethosagent/types';
import { beforeEach } from 'vitest';
import { ConfigRepository } from '../../repositories/config.repository';
import { RoomPolicyService } from '../../services/room-policy.service';

export const DATA = ethosDir();
export const CONFIG = join(DATA, 'config.yaml');
export const fileOf = (platform: string, base: string) => `${DATA}/channels/${platform}/${base}.md`;

export let storage: InMemoryStorage;
export let repo: ConfigRepository;
export let sessions: Session[];
export let svc: RoomPolicyService;

export const channelLines = async () =>
  ((await storage.read(CONFIG)) ?? '').split('\n').filter((l) => l.startsWith('channels.'));

export async function seed(lines: string[], files: Record<string, string> = {}) {
  await storage.mkdir(DATA);
  await storage.write(CONFIG, ['provider: anthropic', 'model: m1', ...lines].join('\n'));
  for (const [path, body] of Object.entries(files)) {
    await storage.mkdir(path.slice(0, path.lastIndexOf('/')));
    await storage.write(path, body);
  }
}

export function makeSession(key: string, updatedAt: number, extra: Partial<Session> = {}): Session {
  return {
    id: key,
    key,
    platform: 'gateway',
    model: 'm',
    provider: 'p',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    },
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    ...extra,
  };
}

export async function failure(p: Promise<unknown>): Promise<EthosError> {
  try {
    await p;
  } catch (e) {
    return e as EthosError;
  }
  throw new Error('expected a rejection');
}

export function setSessions(next: Session[]): void {
  sessions = next;
}

export function installRoomPolicyHarness(): void {
  beforeEach(() => {
    storage = new InMemoryStorage();
    sessions = [];
    repo = new ConfigRepository({ dataDir: DATA, storage, secrets: new InMemorySecretsResolver() });
    svc = new RoomPolicyService({
      storage,
      dataDir: DATA,
      config: repo,
      sessions: {
        listSessions: async (f) =>
          sessions
            .filter((s) => (f?.keyPrefix ? s.key.startsWith(f.keyPrefix) : true))
            .slice(0, f?.limit ?? 100),
      },
    });
  });
}
