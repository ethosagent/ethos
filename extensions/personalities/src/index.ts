export {
  buildDidDocument,
  canonicalize,
  deriveDidKey,
  type Ed25519KeyPair,
  fingerprint,
  generateEd25519,
  publicKeyMultibase,
  rawPublicKeyFromPem,
  signCard,
  verifyCard,
} from './a2a-crypto';
export {
  type A2aIdentityProviderOptions,
  type A2aPersonalitySource,
  type A2aSkillToolsResolution,
  PersonalityA2aIdentityProvider,
  resolveA2aSkillTools,
} from './a2a-identity';
// plan personality-presence-and-initiative §1 — the birth marker.
export {
  birthMarkerCreatedAt,
  birthMarkerPath,
  clearBirthMarker,
  hasBirthMarker,
  markPersonalityBorn,
  writeBirthMarker,
} from './birth';
export {
  type CharacterSheetBoundary,
  type CharacterSheetDecisionSite,
  type CharacterSheetDecisions,
  type CharacterSheetExecution,
  type CharacterSheetModelFit,
  type CharacterSheetRouting,
  type CharacterSheetScriptSurface,
  firstParagraph,
  renderCharacterSheet,
} from './character-sheet';
export { OUTBOUND_POLICY_PLATFORMS } from './config-builders';
export { setConfigYamlScalars } from './config-yaml';
// L-T3 — `packages/wiring/src/learning-replay.ts` builds an Expression
// candidate's shadow bytes as `serializeLivingSoul({ core, expression:
// candidate, learningLog: current })`, so Core and the learning log stay
// byte-identical to what is on disk. The grammar has one owner
// (`./living-soul`); re-exported here rather than reimplemented there.
export { parseLivingSoul, serializeLivingSoul } from './living-soul';
export { parseMcpYaml, renderMcpYaml } from './mcp-yaml';
// P-T3 — the structured permission surface the sheet's permission sections
// render from, and the diff that classifies a change as widening or narrowing.
export {
  type CharacterSheetMcpExport,
  diffPermissionSurface,
  formatPermissionDiff,
  HIGH_RISK_TOOLS,
  isHighRiskTool,
  KANBAN_CLOSER_TOOLS,
  notComparedLine,
  PERMISSION_DIFF_NOT_COMPARED,
  type PermissionChange,
  type PermissionDiff,
  type PermissionDirection,
  type PermissionSurface,
  permissionSurface,
} from './permission-surface';
export {
  AVATAR_MIME_TO_EXT,
  createPersonalityRegistry,
  DefinitionChangedError,
  FilePersonalityRegistry,
  hashDefinitionBytes,
  readPersonalityFingerprintSources,
  SYSTEM_PERSONALITY_IDS,
} from './registry';
export { parseToolsYaml, renderToolsYaml, TOOLS_YAML_KEYS, type ToolsYamlKey } from './tools-yaml';
export type {
  CreatePersonalityInput,
  DefinitionBytesFile,
  DescribedPersonality,
  EditableVoiceConfig,
  PersonalityLoadFailure,
  PersonalityLoadReport,
  PersonalityToolsConfig,
  UpdatePersonalityPatch,
} from './types';
