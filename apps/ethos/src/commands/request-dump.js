import { join } from 'node:path';
import { ethosDir } from '../config';
export async function runRequestDump(args) {
  const { JsonlRequestDumpStore } = await import('@ethosagent/request-dump');
  let turns = 10;
  let includeContent = false;
  let sessionId;
  let since;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--include-content') includeContent = true;
    else if (arg?.startsWith('--turns=')) turns = parseInt(arg.slice(8), 10);
    else if (arg?.startsWith('--session-id=')) sessionId = arg.slice(13);
    else if (arg?.startsWith('--since=')) since = new Date(arg.slice(8));
  }
  const dir = join(ethosDir(), 'request-dumps');
  const store = new JsonlRequestDumpStore({ dir });
  const records = await store.recent({ limit: turns, sessionId, since, includeContent });
  if (records.length === 0) {
    console.log('No request dump records found.');
    console.log(
      'Enable request dumps: set observability.requestDump.enabled: true in ~/.ethos/config.yaml',
    );
    process.exitCode = 1;
    return;
  }
  for (const record of records) {
    console.log(JSON.stringify(record));
  }
}
