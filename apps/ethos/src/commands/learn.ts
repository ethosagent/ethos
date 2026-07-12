import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

export async function runLearn(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'log') {
    await showLearnLog();
    return;
  }

  console.log(`${c.bold}ethos learn${c.reset}`);
  console.log('');
  console.log('  Use /learn in a chat session to capture knowledge.');
  console.log('');
  console.log(`${c.dim}Usage in chat:${c.reset}`);
  console.log('  /learn                    distill the current conversation');
  console.log('  /learn remember: <text>   save as memory');
  console.log('  /learn skill: <text>      propose as a skill');
  console.log('  /learn <description>      auto-route memory or skill');
  console.log('');
  console.log(`${c.dim}Subcommands:${c.reset}`);
  console.log('  ethos learn log           show learning history');
}

async function showLearnLog(): Promise<void> {
  const { FsStorage } = await import('@ethosagent/storage-fs');
  const storage = new FsStorage();
  const memoryPath = join(ethosDir(), 'MEMORY.md');
  const content = await storage.read(memoryPath);

  if (!content) {
    console.log(`${c.dim}No learning log entries yet.${c.reset}`);
    return;
  }

  const lines = content.split('\n').filter((line) => line.startsWith('[learned]'));
  if (lines.length === 0) {
    console.log(`${c.dim}No learning log entries yet.${c.reset}`);
    return;
  }

  console.log(`${c.bold}Learning Log${c.reset} (${lines.length} entries)`);
  console.log('');
  for (const line of lines) {
    console.log(`  ${c.dim}${line}${c.reset}`);
  }
}
