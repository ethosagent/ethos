// Entry of a plugin host process (plan plugin-process-isolation D14). Spawned by
// `PluginHostPool`; never run by a user. Speaks JSON-RPC on stdin/stdout.
import { FsStorage, runPluginHostChild } from '@ethosagent/wiring';

runPluginHostChild({ storage: new FsStorage() });
