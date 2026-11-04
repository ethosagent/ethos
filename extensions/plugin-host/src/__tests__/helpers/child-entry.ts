// Test-only child entry: the same three lines as apps/ethos/src/plugin-host-child.ts,
// importing the runtime from source instead of through @ethosagent/wiring.
import { FsStorage } from '@ethosagent/storage-fs';
import { runPluginHostChild } from '../../child';

runPluginHostChild({ storage: new FsStorage() });
