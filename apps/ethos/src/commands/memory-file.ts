// `ethos memory [show | add "<text>" | clear]` for the file-memory backends —
// markdown at ~/.ethos, or the vault under `memory: vault` (F04 follow-up). The
// vector backend has its own branch in index.ts (showRecent / add / export /
// clear over memory.db); anything that reaches here goes through
// `openFileMemory`, so it acts on the files the agent reads.
import type { EthosConfig } from '@ethosagent/config';
import type { MemoryContext } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { openFileMemory } from '../lib/file-memory';

export async function runMemoryFileCommand(
  sub: string,
  args: string[],
  config: EthosConfig | null,
  jsonMode: boolean,
): Promise<void> {
  const mem = openFileMemory(config, 'tool').provider;
  const personalityId = config?.personality ?? 'default';
  const cliCtx: MemoryContext = {
    scopeId: `personality:${personalityId}`,
    sessionId: '',
    sessionKey: 'cli',
    platform: 'cli',
    workingDir: process.cwd(),
  };

  if (sub === 'show' || sub === '') {
    const result = await mem.prefetch(cliCtx);
    if (jsonMode) {
      writeJson({
        entries: result
          ? result.entries.map((e) => ({ key: e.key, content: e.content.trim() }))
          : [],
      });
      return;
    }
    if (result && result.entries.length > 0) {
      console.log(result.entries.map((e) => e.content.trim()).join('\n\n'));
    } else {
      console.log('No memory yet.');
    }
  } else if (sub === 'add') {
    const text = args.slice(2).join(' ');
    if (!text) {
      console.error('Usage: ethos memory add "<text>"');
      process.exit(1);
    }
    await mem.sync([{ action: 'add', key: 'MEMORY.md', content: text }], cliCtx);
    console.log('Added to memory.');
  } else if (sub === 'clear') {
    await mem.sync([{ action: 'replace', key: 'MEMORY.md', content: '' }], cliCtx);
    console.log('Memory cleared.');
  } else {
    console.log(
      'Usage: ethos memory [show | add "<text>" | clear | history | restore <slug> | ' +
        'supersede <slug> --by <slug> | retract <slug>]',
    );
  }
}
