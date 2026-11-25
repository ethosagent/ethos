// Subpath entry `@ethosagent/gateway/room-policy`: the pure per-room policy
// surface only, so `@ethosagent/wiring` (and through it the web-api) reaches the
// resolver without importing the gateway root, which pulls the stores, spool and
// ledger (plan channel-prompts-ui §3.1, D1). Re-exports only; no logic here.

export {
  buildRoomPolicyTable,
  type PlatformRoomPolicy,
  type ResolvedRoomPolicy,
  ROOM_BLOCK_MAX_CHARS,
  ROOM_PROMPT_LAYER_MAX_CHARS,
  type RoomEntry,
  type RoomIdentity,
  type RoomMatchSource,
  type RoomPolicyBuildOptions,
  type RoomPolicyBuildResult,
  type RoomPolicyInput,
  type RoomPolicySources,
  type RoomPolicyTable,
  type RoomPromptFile,
  renderRoomPrompt,
  resolveRoomPolicy,
  roomModeDefault,
  roomPolicyDigest,
  roomSelectorFromFile,
  slugRoomName,
} from './room-policy';
export { ROOM_POLICY_IS_DM_KEY, RoomTurnPolicies } from './room-turn';
