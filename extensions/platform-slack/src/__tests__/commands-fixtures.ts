import type { Storage, StorageDirEntry } from '@ethosagent/types';
import type { SlashContext } from '../commands';

export function memStorage(): Storage {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    async read(p) {
      return files.get(p) ?? null;
    },
    async readBytes(p) {
      const s = files.get(p);
      return s === undefined ? null : new TextEncoder().encode(s);
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async mtime(p) {
      return files.has(p) ? Date.now() : null;
    },
    async list() {
      return [];
    },
    async listEntries(): Promise<StorageDirEntry[]> {
      return [];
    },
    async write(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async append(p, content) {
      files.set(p, (files.get(p) ?? '') + content);
    },
    async writeAtomic(p, content) {
      files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf-8'));
    },
    async mkdir(d) {
      dirs.add(d);
    },
    async remove(p) {
      files.delete(p);
    },
    async rename(from, to) {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
    },
    async chmod() {},
  };
}

export function ctxFor(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    binding: { type: 'personality', name: 'researcher' },
    defaultChannelMode: 'mention_only',
    // The gate is default-deny (CHS-001), so every subcommand test runs as an
    // allowlisted caller. The gate itself is covered in `slash-authz.test.ts`.
    allowedUsers: ['U1'],
    ...overrides,
  };
}

export const basePayload = {
  command: '/ethos',
  channel_id: 'C1',
  user_id: 'U1',
  trigger_id: 'tg-1',
};
