import { describe, expect, it } from 'vitest';
import type {
  CallCaptureCheckResult,
  CallCaptureDaemonHealthResult,
  CheckCallCaptureOptions,
  CodexModelCheck,
  DbCheckResult,
  DecisionLayerReport,
  DecisionPersonalityReport,
  DirSanityIssue,
  DockerSandboxReport,
  DoctorFailFlags,
  DoctorOptions,
  InboundSpoolReport,
  IntegrityResult,
  ProviderProbeResult,
  SecretCheckResult,
  SessionsFtsDrift,
  StateDirFilesystemResult,
  VaultModeResult,
} from '../commands/doctor';

// Compile-time pin: every type-only export of doctor.ts must stay importable
// from it, whichever sibling module owns the declaration (`pnpm typecheck`).
export type DoctorTypeSurface = [
  CallCaptureCheckResult,
  CallCaptureDaemonHealthResult,
  CheckCallCaptureOptions,
  CodexModelCheck,
  DbCheckResult,
  DecisionLayerReport,
  DecisionPersonalityReport,
  DirSanityIssue,
  DockerSandboxReport,
  DoctorFailFlags,
  DoctorOptions,
  InboundSpoolReport,
  IntegrityResult,
  ProviderProbeResult,
  SecretCheckResult,
  SessionsFtsDrift,
  StateDirFilesystemResult,
  VaultModeResult,
];

describe('doctor.ts export surface', () => {
  it('exports exactly the pre-split runtime names', async () => {
    const mod = await import('../commands/doctor');
    expect(Object.keys(mod).sort()).toEqual([
      'checkCallCapture',
      'checkCallCaptureDaemonHealth',
      'checkCodexModel',
      'checkDatabaseIntegrity',
      'checkDecisionLayer',
      'checkDockerSandbox',
      'checkInboundSpool',
      'checkSecrets',
      'checkSecretsDirMode',
      'checkSessionsDb',
      'checkSkillsDir',
      'checkStateDirFilesystem',
      'checkTeamsDir',
      'computeDoctorExit',
      'configuredGatewayBotKeys',
      'decisionLayerLines',
      'describeInboundSpool',
      'describeSecretsDirMode',
      'dockerSandboxLines',
      'formatFunnelDuration',
      'integrityAdvice',
      'providerChainLines',
      'runDoctor',
      'runFunnelReport',
      'sessionsFtsOf',
      'suggestProvider',
      'telephonyReport',
    ]);
  });
});
