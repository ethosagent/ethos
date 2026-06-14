import {
  c2PatternCheck,
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  resolveDowngradedTools,
  sanitize,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { detectSecrets, redactPii, redactString } from '@ethosagent/safety-redact';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import type { AgentSafety, InjectionDefenseKit, RedactionKit } from '@ethosagent/types';

type TestSafetyOverrides = Omit<Partial<AgentSafety>, 'injection' | 'redaction'> & {
  injection?: Partial<InjectionDefenseKit>;
  redaction?: Partial<RedactionKit>;
};

export function createTestSafety(overrides?: TestSafetyOverrides): AgentSafety {
  return {
    injection: {
      prelude: INJECTION_DEFENSE_PRELUDE,
      downgradeRejectionMessage: DOWNGRADE_REJECTION_MESSAGE,
      sanitize,
      wrapUntrusted,
      shortPatternCheck,
      c2PatternCheck,
      resolveDowngradedTools,
      ...overrides?.injection,
    },
    redaction: {
      redactPii,
      redactString,
      detectSecrets,
      ...overrides?.redaction,
    },
    scopedStorageFactory:
      overrides?.scopedStorageFactory ??
      ((base, scope) => new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() })),
    watcher: overrides?.watcher,
  };
}
