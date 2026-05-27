import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

export interface PluginLockEntry {
  package: string;
  version: string;
  registry: string;
  integrity: string;
}

export type PluginLockfile = Record<string, PluginLockEntry>;

const LOCKFILE_NAME = 'plugins.lock';

export async function readLockfile(
  storage: Storage,
  personalityDir: string,
): Promise<PluginLockfile> {
  const content = await storage.read(join(personalityDir, LOCKFILE_NAME));
  if (content === null) return {};
  return JSON.parse(content) as PluginLockfile;
}

export async function writeLockfile(
  storage: Storage,
  personalityDir: string,
  lockfile: PluginLockfile,
): Promise<void> {
  await storage.write(
    join(personalityDir, LOCKFILE_NAME),
    `${JSON.stringify(lockfile, null, 2)}\n`,
  );
}

export async function computeIntegrity(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const hash = createHash('sha512').update(content).digest('base64');
  return `sha512-${hash}`;
}

export async function verifyIntegrity(
  filePath: string,
  expectedIntegrity: string,
): Promise<boolean> {
  try {
    const actual = await computeIntegrity(filePath);
    return actual === expectedIntegrity;
  } catch {
    return false;
  }
}
