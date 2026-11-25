// The room-policy slice of the gateway's public surface, re-exported by index.ts.

export {
  buildRoomPolicyTable,
  type PlatformRoomPolicy,
  type ResolvedRoomPolicy,
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
export { RoomTurnPolicies } from './room-turn';
