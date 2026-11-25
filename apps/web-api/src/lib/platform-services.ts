// The platform-facing services `assembleWebApi` builds together (split out of
// index.ts): the platforms service and the per-room prompt/policy service, both
// reading and writing through the same `ConfigRepository`.

import type { SecretsResolver, SessionStore, Storage } from '@ethosagent/types';
import type { ConfigRepository } from '../repositories/config.repository';
import { PlatformsRepository } from '../repositories/platforms.repository';
import { PlatformsService } from '../services/platforms.service';
import { RoomPolicyService } from '../services/room-policy.service';

export function buildPlatformServices(deps: {
  configRepo: ConfigRepository;
  secrets: SecretsResolver;
  storage: Storage;
  dataDir: string;
  sessions: SessionStore;
}): { platformsService: PlatformsService; roomPoliciesService: RoomPolicyService } {
  const { configRepo, secrets, storage, dataDir, sessions } = deps;
  const platformsRepo = new PlatformsRepository({ config: configRepo, secrets, dataDir, storage });
  return {
    platformsService: new PlatformsService({ repo: platformsRepo }),
    roomPoliciesService: new RoomPolicyService({
      storage,
      dataDir,
      config: configRepo,
      sessions,
    }),
  };
}
