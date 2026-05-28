import { FsStorage } from '@ethosagent/storage-fs';
const defaultStorage = new FsStorage();
export async function readCheckpoint(path, storage = defaultStorage) {
    const src = await storage.read(path);
    if (!src)
        return { version: 1, completedTaskIds: [], failedTaskIds: [] };
    try {
        return JSON.parse(src);
    }
    catch {
        return { version: 1, completedTaskIds: [], failedTaskIds: [] };
    }
}
// Atomic write: storage.writeAtomic uses tmp+rename so a mid-write SIGTERM
// leaves either the old checkpoint or the new one intact — never a partial file.
export async function writeCheckpoint(path, state, storage = defaultStorage) {
    await storage.writeAtomic(path, JSON.stringify(state, null, 2));
}
