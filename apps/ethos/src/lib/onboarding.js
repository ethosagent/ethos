// FW-16 — one-time consent gate for quick commands.
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';

function onboardingPath(dataDir) {
  return join(dataDir, 'onboarding.json');
}
export async function hasQuickCommandConsent(dataDir, storage) {
  const s = storage ?? new FsStorage();
  const raw = await s.read(onboardingPath(dataDir));
  if (!raw) return false;
  try {
    const state = JSON.parse(raw);
    return state.seen?.quick_commands_consent === true;
  } catch {
    return false;
  }
}
export async function grantQuickCommandConsent(dataDir, storage) {
  const s = storage ?? new FsStorage();
  const path = onboardingPath(dataDir);
  const raw = await s.read(path);
  let state = {};
  if (raw) {
    try {
      state = JSON.parse(raw);
    } catch {
      state = {};
    }
  }
  state.seen ??= {};
  state.seen.quick_commands_consent = true;
  await s.writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}
