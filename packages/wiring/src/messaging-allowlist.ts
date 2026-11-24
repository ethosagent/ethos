import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';

/**
 * Read `<dataDir>/messaging.json` and return a `Map<personalityId, targets[]>`.
 * Missing file or parse failure → empty map (everything stays default-deny).
 */
export async function loadMessagingAllowlist(dataDir: string): Promise<Map<string, string[]>> {
  const storage = new FsStorage();
  const path = join(dataDir, 'messaging.json');
  const raw = await storage.read(path);
  if (!raw) return new Map();
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, string[]>();
    for (const [personalityId, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const targets = value.filter((t): t is string => typeof t === 'string');
      out.set(personalityId, targets);
    }
    return out;
  } catch {
    return new Map();
  }
}
