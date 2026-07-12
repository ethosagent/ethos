import type { Storage } from '@ethosagent/types';
import type { CheckpointState } from './types';

export async function readCheckpoint(path: string, storage: Storage): Promise<CheckpointState> {
  const src = await storage.read(path);
  if (!src) return { version: 1, completedTaskIds: [], failedTaskIds: [] };
  try {
    return JSON.parse(src) as CheckpointState;
  } catch {
    return { version: 1, completedTaskIds: [], failedTaskIds: [] };
  }
}

// Atomic write: storage.writeAtomic uses tmp+rename so a mid-write SIGTERM
// leaves either the old checkpoint or the new one intact — never a partial file.
export async function writeCheckpoint(
  path: string,
  state: CheckpointState,
  storage: Storage,
): Promise<void> {
  await storage.writeAtomic(path, JSON.stringify(state, null, 2));
}
