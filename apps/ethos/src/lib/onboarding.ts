// FW-16 — one-time consent gate for quick commands.

import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';

interface OnboardingState {
  seen?: {
    quick_commands_consent?: boolean;
  };
}

function onboardingPath(dataDir: string): string {
  return join(dataDir, 'onboarding.json');
}

export async function hasQuickCommandConsent(dataDir: string, storage?: Storage): Promise<boolean> {
  const s = storage ?? new FsStorage();
  const raw = await s.read(onboardingPath(dataDir));
  if (!raw) return false;
  try {
    const state = JSON.parse(raw) as OnboardingState;
    return state.seen?.quick_commands_consent === true;
  } catch {
    return false;
  }
}

export async function grantQuickCommandConsent(dataDir: string, storage?: Storage): Promise<void> {
  const s = storage ?? new FsStorage();
  const path = onboardingPath(dataDir);
  const raw = await s.read(path);
  let state: OnboardingState = {};
  if (raw) {
    try {
      state = JSON.parse(raw) as OnboardingState;
    } catch {
      state = {};
    }
  }
  state.seen ??= {};
  state.seen.quick_commands_consent = true;
  await s.writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}
