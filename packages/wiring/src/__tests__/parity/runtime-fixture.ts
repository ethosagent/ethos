// Shared by P1 and P2: one real `createAgentLoop` composition under a hermetic env,
// with a minimal config (anthropic key, markdown memory, no platforms).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentLoop } from '../../index';
import { type HermeticEnv, type ScriptedLLM, scriptedLLM, withHermeticEnv } from './harness';

export type ParityRuntime = Awaited<ReturnType<typeof createAgentLoop>>;

const REPO_ROOT = join(import.meta.dirname, '../../../../..');
const BUILTIN_DIR = join(REPO_ROOT, 'extensions/personalities/data');

/** Ids of the shipped personalities (`data/<id>/`, minus `archived/`). */
export function builtinPersonalityIds(): string[] {
  return readdirSync(BUILTIN_DIR)
    .filter((d) => d !== 'archived' && statSync(join(BUILTIN_DIR, d)).isDirectory())
    .sort();
}

export interface ParityHarnessRuntime {
  env: HermeticEnv;
  runtime: ParityRuntime;
  llm: ScriptedLLM;
  close: () => Promise<void>;
}

export async function createParityRuntime(): Promise<ParityHarnessRuntime> {
  const env = withHermeticEnv();
  try {
    const runtime = await createAgentLoop(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-parity',
        memory: 'markdown',
      },
      { dataDir: env.stateDir, workingDir: env.home, disableDocker: true, profile: 'cli' },
    );
    // The loop holds its provider in `llm`; swap in the recording one so no request
    // leaves the process. (Same read seam usage-meter-wiring.test.ts uses.)
    const llm = scriptedLLM();
    Reflect.set(runtime.loop, 'llm', llm);
    return {
      env,
      runtime,
      llm,
      close: async () => {
        await runtime.dispose();
        env.restore();
      },
    };
  } catch (err) {
    env.restore();
    throw err;
  }
}
