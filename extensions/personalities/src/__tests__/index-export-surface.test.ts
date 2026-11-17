import { FsStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import type {
  A2aIdentityProviderOptions,
  A2aPersonalitySource,
  A2aSkillToolsResolution,
  CharacterSheetBoundary,
  CharacterSheetDecisionSite,
  CharacterSheetDecisions,
  CharacterSheetExecution,
  CharacterSheetMcpExport,
  CharacterSheetModelFit,
  CharacterSheetRouting,
  CharacterSheetScriptSurface,
  CreatePersonalityInput,
  DefinitionBytesFile,
  DescribedPersonality,
  Ed25519KeyPair,
  EditableVoiceConfig,
  PermissionChange,
  PermissionDiff,
  PermissionDirection,
  PermissionSurface,
  PersonalityLoadFailure,
  PersonalityLoadReport,
  PersonalityToolsConfig,
  ToolsYamlKey,
  UpdatePersonalityPatch,
} from '../index';
import * as surface from '../index';

// Type-only exports: a missing one fails `pnpm typecheck` on the import above.
export type TypeOnlySurface = [
  A2aIdentityProviderOptions,
  A2aPersonalitySource,
  A2aSkillToolsResolution,
  CharacterSheetBoundary,
  CharacterSheetDecisions,
  CharacterSheetDecisionSite,
  CharacterSheetExecution,
  CharacterSheetMcpExport,
  CharacterSheetModelFit,
  CharacterSheetRouting,
  CharacterSheetScriptSurface,
  CreatePersonalityInput,
  DefinitionBytesFile,
  DescribedPersonality,
  Ed25519KeyPair,
  EditableVoiceConfig,
  PermissionChange,
  PermissionDiff,
  PermissionDirection,
  PermissionSurface,
  PersonalityLoadFailure,
  PersonalityLoadReport,
  PersonalityToolsConfig,
  ToolsYamlKey,
  UpdatePersonalityPatch,
];

describe('@ethosagent/personalities export surface', () => {
  it('keeps the runtime export list of src/index.ts unchanged', () => {
    expect(Object.keys(surface).sort()).toEqual([
      'AVATAR_MIME_TO_EXT',
      'DefinitionChangedError',
      'FilePersonalityRegistry',
      'HIGH_RISK_TOOLS',
      'KANBAN_CLOSER_TOOLS',
      'OUTBOUND_POLICY_PLATFORMS',
      'PERMISSION_DIFF_NOT_COMPARED',
      'PersonalityA2aIdentityProvider',
      'SYSTEM_PERSONALITY_IDS',
      'TOOLS_YAML_KEYS',
      'birthMarkerCreatedAt',
      'birthMarkerPath',
      'buildDidDocument',
      'canonicalize',
      'clearBirthMarker',
      'createPersonalityRegistry',
      'deriveDidKey',
      'diffPermissionSurface',
      'fingerprint',
      'firstParagraph',
      'formatPermissionDiff',
      'generateEd25519',
      'hasBirthMarker',
      'hashDefinitionBytes',
      'isHighRiskTool',
      'markPersonalityBorn',
      'notComparedLine',
      'parseLivingSoul',
      'parseMcpYaml',
      'parseToolsYaml',
      'permissionSurface',
      'publicKeyMultibase',
      'rawPublicKeyFromPem',
      'readPersonalityFingerprintSources',
      'renderCharacterSheet',
      'renderMcpYaml',
      'renderToolsYaml',
      'resolveA2aSkillTools',
      'serializeLivingSoul',
      'setConfigYamlScalars',
      'signCard',
      'verifyCard',
      'writeBirthMarker',
    ]);
  });

  // The built-in `data/` directory is found with
  // `join(import.meta.dirname, '..', 'data')`, relative to the module that
  // holds `loadBuiltins`. Every module split out of index.ts stays in this
  // directory so the lookup keeps resolving to the same place.
  it('built-in personalities still load after split', async () => {
    const registry = await surface.createPersonalityRegistry(new FsStorage());
    const ids = registry.list().map((p) => p.id);
    for (const id of [
      'researcher',
      'engineer',
      'reviewer',
      'debug',
      'personality-architect',
      'team-architect',
    ]) {
      expect(ids).toContain(id);
    }
    const researcher = registry.get('researcher');
    expect(researcher?.soulFile).toMatch(/personalities\/data\/researcher\/SOUL\.md$/);
    expect(researcher?.toolset?.length).toBeGreaterThan(0);
  });
});
